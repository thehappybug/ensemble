import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,readFile,rm,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime,type WorkspaceRuntime } from '../src/daemon.js';
import { configSchema } from '../src/config.js';
import { FakeRunner } from '../src/runner/FakeRunner.js';
import { rebuildIndex,mergeManagedBlock,MANAGED_BEGIN,MANAGED_END } from '../src/librarian/index.js';
import type { SummaryProvider } from '../src/librarian/summarize.js';

const runtimes:WorkspaceRuntime[]=[],roots:string[]=[];
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup() {
  const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-librarian-'));roots.push(root);
  const files:Record<string,string>={'ensemble.yaml':'version: 1\nname: test\n','context/icp.md':'Customers need public APIs.','topics/research.prompt.md':'---\ninputs: [/context/icp.md]\noutputs: [research.md]\ndescription: Research customers\n---\nResearch','ranking.prompt.md':'---\ninputs: [topics/research.md]\noutputs: [ranking.md]\n---\nRank','context/AGENTS.md':'# My context\n\nKeep this custom instruction exactly.\n','context/CLAUDE.md':'Custom Claude context\n','.gitignore':'.ensemble/\n.env\nignored/\n','ignored/user.md':'Should be ignored','exports/report.pdf':'binary','node_modules/pkg/index.js':'package','.agents/skills/ensemble/SKILL.md':'# Ensemble authoring skill'};
  for(const [file,content] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  await mkdir(path.join(root,'empty-parent/empty-child'),{recursive:true});
  const config=configSchema.parse({name:'test',git:{auto_commit:false},agents_md:{summaries:false}}),runtime=await createRuntime(root,{config,runner:new FakeRunner()});runtimes.push(runtime);
  return {root,runtime};
}

describe('deterministic librarian',()=>{
  it('preserves exact outside bytes and safely rejects malformed or duplicate markers',()=>{
    const before='Custom prefix\r\n',after='\r\nCustom suffix, no final newline';
    expect(mergeManagedBlock(`${before}<!-- ensemble:begin -->\nold\n${MANAGED_END}${after}`,'new')).toBe(`${before}${MANAGED_BEGIN}\nnew\n${MANAGED_END}${after}`);
    for(const source of [`${MANAGED_BEGIN}\nno end`,`${MANAGED_END}\n${MANAGED_BEGIN}`,`${MANAGED_BEGIN}\n${MANAGED_BEGIN}\n${MANAGED_END}`,'<!-- ensemble:begin broken'])expect(()=>mergeManagedBlock(source,'new')).toThrow('Malformed');
  });
  it('indexes every eligible directory, preserves user instructions, and creates only missing shims',async()=>{
    const {root,runtime}=await setup(),result=await rebuildIndex(runtime,{noLlm:true});
    expect(result.changed).toContain('AGENTS.md');expect(result.changed).toContain('.agents/skills/ensemble/AGENTS.md');expect(result.changed).toContain('empty-parent/AGENTS.md');
    const rootIndex=await readFile(path.join(root,'AGENTS.md'),'utf8'),context=await readFile(path.join(root,'context/AGENTS.md'),'utf8');
    expect(context.startsWith('# My context\n\nKeep this custom instruction exactly.\n')).toBe(true);
    expect(await readFile(path.join(root,'context/CLAUDE.md'),'utf8')).toBe('Custom Claude context\n');
    expect(await readFile(path.join(root,'topics/CLAUDE.md'),'utf8')).toBe('@AGENTS.md\n');
    expect(rootIndex).toContain('How this workspace works');expect(rootIndex).toContain('write a `*.prompt.md` file');expect(rootIndex).toContain('plan → approve → execute');
    for(const directory of ['ignored','exports','node_modules/pkg','empty-parent/empty-child'])await expect(stat(path.join(root,directory,'AGENTS.md'))).rejects.toThrow();
  });
  it('writes producer, state, date, prompts, consumers, parent and root links deterministically',async()=>{
    const {root,runtime}=await setup();await runtime.scheduler.run();await rebuildIndex(runtime,{noLlm:true});
    const topics=await readFile(path.join(root,'topics/AGENTS.md'),'utf8');
    expect(topics).toContain('[research.prompt.md](research.prompt.md)');expect(topics).toContain('**Parent:** [../AGENTS.md](../AGENTS.md)');expect(topics).toContain('**Workspace root:** [/AGENTS.md](../AGENTS.md)');
    expect(topics).toContain('fresh · '+runtime.store.data.nodes['topics/research'].lastSuccess!.at.slice(0,10));
    expect(topics).toContain('`/context/icp.md` → `research.md`');expect(topics).toContain('**Downstream consumers:** [../ranking.prompt.md](../ranking.prompt.md)');
  });
  it('is idempotent and generated context writes do not change prompt fingerprints or trigger reruns',async()=>{
    const {runtime,root}=await setup();await runtime.scheduler.run();const before=Object.fromEntries(runtime.scheduler.graph.nodes.map(node=>[node.id,node.fingerprint]));
    await rebuildIndex(runtime,{noLlm:true});const firstMtime=(await stat(path.join(root,'AGENTS.md'))).mtimeMs;
    const second=await rebuildIndex(runtime,{noLlm:true});expect(second.changed).toEqual([]);expect((await stat(path.join(root,'AGENTS.md'))).mtimeMs).toBe(firstMtime);
    await runtime.scheduler.refresh();expect(Object.fromEntries(runtime.scheduler.graph.nodes.map(node=>[node.id,node.fingerprint]))).toEqual(before);expect(runtime.scheduler.graph.nodes.every(node=>node.status==='fresh')).toBe(true);
  });
  it('leaves malformed managed files untouched and reports a warning',async()=>{
    const {root,runtime}=await setup(),source='# Important user text\n'+MANAGED_BEGIN+'\nunfinished';await writeFile(path.join(root,'AGENTS.md'),source);
    const result=await rebuildIndex(runtime,{noLlm:true});expect(await readFile(path.join(root,'AGENTS.md'),'utf8')).toBe(source);expect(result.warnings.some(warning=>warning.includes('Malformed'))).toBe(true);
  });
  it('uses injected summaries and batches only changed generated files into one git commit',async()=>{
    const {root,runtime}=await setup();runtime.config.agents_md.summaries=true;
    const provider=vi.fn<SummaryProvider>(async(items,context)=>Object.fromEntries(items.map(item=>[item.key,context.kind==='files'?'A short file summary.':'A directory purpose.'])));
    const commit=vi.spyOn(runtime.git,'commitFiles').mockResolvedValue('a'.repeat(40));
    const first=await rebuildIndex(runtime,{summarizer:provider});expect(first.commit).toBe('a'.repeat(40));expect(commit).toHaveBeenCalledOnce();expect(commit.mock.calls[0][0]).toEqual(first.changed);
    expect(commit.mock.calls[0][1]).toMatch(/^chore\(agents-md\): update \d+ directories$/);expect(await readFile(path.join(root,'topics/AGENTS.md'),'utf8')).toContain('A short file summary.');
    const second=await rebuildIndex(runtime,{summarizer:provider});expect(second.changed).toEqual([]);expect(commit).toHaveBeenCalledOnce();
  });
});
