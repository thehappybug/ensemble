import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {expect,it} from 'vitest';
import {initWorkspace,clonePrompt,newPrompt} from '../src/workspace/commands.js';
import {loadConfig} from '../src/config.js';
import {buildGraph} from '../src/graph/build.js';
it('initializes an example and clones a prompt into another directory with distinct outputs and intact lineage',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-init-'));await initWorkspace(root,'coding-agents-icp');await clonePrompt(root,'coding-agents/top-10.prompt.md','research/top.prompt.md');const graph=await buildGraph(root,await loadConfig(root));expect(graph.nodes.filter(n=>n.status==='invalid')).toEqual([]);const clone=graph.nodes.find(n=>n.path==='research/top.prompt.md')!;expect(clone.fm.derived_from).toBe('coding-agents/top-10.prompt.md');expect(clone.outputs).toEqual(['coding-agents/top-10-v2.csv','coding-agents/top-10-v2.csv.sources.json']);expect(clone.inputs).toEqual([]);});
it('new prompts default manual and refuse existing files',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'ensemble-new-'));await initWorkspace(root);await newPrompt(root,'topic.prompt.md',{fromDescription:'Research a public topic'});const graph=await buildGraph(root,await loadConfig(root));expect(graph.nodes[0].fm.mode).toBe('manual');await expect(newPrompt(root,'topic.prompt.md')).rejects.toThrow('exists');});
