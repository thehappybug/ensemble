import { afterEach,describe,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildGraph } from '../src/graph/build.js';
import { loadConfig,findWorkspace } from '../src/config.js';
import { parsePrompt,renderTemplate } from '../src/workspace/frontmatter.js';
import { resolvePath } from '../src/workspace/paths.js';
import { expandFanout } from '../src/workspace/fanout.js';
import { canonicalJSON } from '../src/workspace/hashing.js';
import { parseCSV } from '../src/workspace/csv.js';

const roots:string[]=[];
async function workspace(files:Record<string,string>={}):Promise<string> {
  const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-core-'));roots.push(root);
  for(const [file,content] of Object.entries({'ensemble.yaml':'version: 1\nname: test\n',...files})) {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  return root;
}
const prompt=(inputs:string[],outputs:string[],body='Write outputs',extra='')=>`---\ninputs: ${JSON.stringify(inputs)}\noutputs: ${JSON.stringify(outputs)}\n${extra}---\n${body}`;
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('core workspace model',()=>{
  it('reads RFC4180 quoting, multiline fields and BOM; validates malformed records',()=>{
    expect(parseCSV('\uFEFFname,note\r\n"Acme, Inc","line one\nline ""two"""\r\n')).toEqual([{name:'Acme, Inc',note:'line one\nline "two"'}]);
    expect(()=>parseCSV('a,a\n1,2')).toThrow('distinct');
    expect(()=>parseCSV('a,b\n1')).toThrow('fields');
    expect(()=>parseCSV('a\n"unclosed')).toThrow('Unterminated');
  });
  it('loads defaults and finds a workspace from nested directories',async()=>{
    const root=await workspace({'nested/deep/input.md':'hello'});
    expect(await findWorkspace(path.join(root,'nested/deep'))).toBe(root);
    expect((await loadConfig(root)).scheduler.concurrency).toBe(3);
  });
  it('rejects config secrets and malformed frontmatter, warns for unknown keys',async()=>{
    const root=await workspace({'ensemble.yaml':'version: 1\nllm:\n  api_key: secret\n'});
    await expect(loadConfig(root)).rejects.toThrow('Secrets');
    expect(()=>parsePrompt('---\noutputs: []\n---\nbody','x.prompt.md')).toThrow('outputs');
    expect(parsePrompt(prompt([],['out.md'],'Body','typo: true\n'),'x.prompt.md').warnings).toHaveLength(1);
    expect(()=>renderTemplate('{{vars.missing}}',{vars:{}})).toThrow();
    expect(renderTemplate('{{upper name}} {{slugify name}}',{name:'Acme Agent'})).toBe('ACME AGENT acme-agent');
  });
  it('resolves root-relative paths and rejects lexical and symlink escapes',async()=>{
    const root=await workspace();const outside=await workspace();
    expect(resolvePath(root,'topics/a.prompt.md','/context/icp.md')).toBe('context/icp.md');
    expect(()=>resolvePath(root,'a.prompt.md','../outside.md')).toThrow('escapes');
    await symlink(outside,path.join(root,'link'));
    expect(()=>resolvePath(root,'a.prompt.md','link/new/output.md')).toThrow('Symlink');
    expect(()=>resolvePath(root,'a.prompt.md','link/**/*.md')).toThrow('Symlink');
  });
  it('matches declared outputs before they exist, and reports ownership and cycles',async()=>{
    const root=await workspace({'a.prompt.md':prompt([],['out/a.md']),'b.prompt.md':prompt(['out/*.md'],['out/b.txt'])});
    let graph=await buildGraph(root,await loadConfig(root));
    expect(graph.edges).toEqual([{source:'a',target:'b'}]);expect(graph.nodes.find(n=>n.id==='b')?.status).toBe('stale');
    await writeFile(path.join(root,'c.prompt.md'),prompt([],['out/a.md']));
    graph=await buildGraph(root,await loadConfig(root));
    expect(graph.nodes.filter(n=>['a','c'].includes(n.id)).every(n=>n.status==='invalid')).toBe(true);
    await rm(path.join(root,'c.prompt.md'));
    await writeFile(path.join(root,'a.prompt.md'),prompt(['out/b.txt'],['out/a.md']));
    graph=await buildGraph(root,await loadConfig(root));
    expect(graph.nodes.every(n=>n.status==='invalid'&&n.reason?.includes('cycle'))).toBe(true);
  });
  it('blocks missing required inputs, allows optional inputs, and excludes managed files from globs',async()=>{
    const root=await workspace({'AGENTS.md':'index','CLAUDE.md':'@AGENTS.md','out.plan.md':'plan','a.prompt.md':prompt(['missing.md?','*.md'],['out.txt'])});
    const graph=await buildGraph(root,await loadConfig(root));
    expect(graph.nodes[0].inputs).toEqual(['a.prompt.md']);
    await writeFile(path.join(root,'a.prompt.md'),prompt(['missing.md'],['out.txt']));
    expect((await buildGraph(root,await loadConfig(root))).nodes[0].status).toBe('blocked');
  });
  it('uses per-item fingerprints when adding a CSV row; metadata edits are irrelevant',async()=>{
    const source=prompt([],['companies/{{company._key}}/people.md'],'Research {{company.company_name}}','foreach:\n  from: companies.csv\n  as: company\n');
    const root=await workspace({'each.prompt.md':source,'companies.csv':'company_name,website\nAcme,https://acme.test\n','rank.prompt.md':prompt(['companies/*/people.md'],['rank.md'])});
    const config=await loadConfig(root),before=await buildGraph(root,config);
    const old=before.nodes.find(n=>n.id==='each[acme]')!;
    await writeFile(path.join(root,'companies.csv'),'company_name,website\nAcme,https://acme.test\nBeta,https://beta.test\n');
    await writeFile(path.join(root,'each.prompt.md'),source.replace('---\n','---\ndescription: Changed label\nmode: manual\n'));
    const after=await buildGraph(root,config);
    expect(after.nodes.find(n=>n.id===old.id)?.fingerprint).toBe(old.fingerprint);
    expect(after.nodes.filter(n=>n.instanceOf==='each')).toHaveLength(2);
    expect(after.edges).toContainEqual({source:'each[beta]',target:'rank'});
  });
  it('adds pending expansion edges to fan-in and gates large expansions by exact hash',async()=>{
    const root=await workspace({'list.prompt.md':prompt([],['companies.csv']),'each.prompt.md':prompt([],['companies/{{item._key}}/people.md'],'Research {{item.name}}','foreach: companies.csv\n'),'rank.prompt.md':prompt(['companies/*/people.md'],['rank.md'])});
    const config=await loadConfig(root);let graph=await buildGraph(root,config);
    expect(graph.nodes.find(n=>n.id==='each')?.status).toBe('pending-expansion');
    expect(graph.edges).toContainEqual({source:'list',target:'each'});expect(graph.edges).toContainEqual({source:'each',target:'rank'});
    await writeFile(path.join(root,'companies.csv'),'name\nAcme\nBeta\n');config.scheduler.fanout_confirm_over=1;
    graph=await buildGraph(root,config);const group=graph.nodes.find(n=>n.id==='each')!;
    expect(group.status).toBe('awaiting-approval');
    graph=await buildGraph(root,config,{version:1,nodes:{},fanoutApprovals:{each:group.expansionHash!}});
    expect(graph.nodes.filter(n=>n.instanceOf==='each')).toHaveLength(2);
  });
  it('parses JSON datasets, rejects duplicate keys, and canonicalizes maps',async()=>{
    const root=await workspace({'rows.json':'{"companies":[{"name":"Acme"},{"name":"Acme"}]}'});
    await expect(expandFanout(root,'each.prompt.md',{from:'rows.json',as:'company'},{})).rejects.toThrow('Duplicate');
    expect(canonicalJSON({b:1,a:{z:2,x:3}})).toBe(canonicalJSON({a:{x:3,z:2},b:1}));
  });
  it('fingerprints input bytes but ignores mode and description',async()=>{
    const root=await workspace({'input.md':'first','a.prompt.md':prompt(['input.md'],['out.md'])});const config=await loadConfig(root);
    const first=(await buildGraph(root,config)).nodes[0].fingerprint;
    await writeFile(path.join(root,'input.md'),'second');
    expect((await buildGraph(root,config)).nodes[0].fingerprint).not.toBe(first);
  });
});
