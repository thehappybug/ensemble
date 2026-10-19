/** Capture the actual native graph component without requiring a browser. Synthetic data is labeled. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {initWorkspace} from '../src/workspace/commands.js';
import {createRuntime} from '../src/daemon.js';
import {SimulationRunner} from '../src/runner/SimulationRunner.js';
import {loadConfig} from '../src/config.js';
import {createApi} from '../src/server/api.js';
import {NativeGraph,layoutGraph} from '../ui/Graph.js';
import type {GraphData} from '../ui/types.js';
const root=await mkdtemp(path.join(tmpdir(),'ensemble-ui-snapshot-'));
try{
 await initWorkspace(root,'coding-agents-icp');const config=await loadConfig(root);config.vars.row_limit=3;config.composio.dry_run=true;config.agents_md.summaries=false;
 const runtime=await createRuntime(root,{config,runner:new SimulationRunner()});
 try{await runtime.scheduler.run({automatic:true});const graph=await (await createApi(runtime).request('/api/graph')).json() as GraphData;const layout=layoutGraph(graph);
  const native=renderToStaticMarkup(<NativeGraph data={graph}/>).replace(/style="[^"]*"/,'').replace('<svg ',`<svg x="0" y="92" width="${layout.width}" height="${layout.height}" `);
  const image=`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height+146}" viewBox="0 0 ${layout.width} ${layout.height+146}"><rect width="100%" height="100%" fill="#10151e"/><text x="48" y="44" font-family="sans-serif" font-size="25" font-weight="700" fill="#edf6f1">ensemble.</text><text x="48" y="70" font-family="sans-serif" font-size="12" fill="#98a7ba">coding-agents-icp / Research flow</text><rect x="${layout.width-210}" y="28" width="160" height="30" rx="15" fill="#332b17"/><text x="${layout.width-130}" y="48" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#edc978">SIMULATED PREVIEW</text>${native}<text x="48" y="${layout.height+127}" font-family="sans-serif" font-size="12" fill="#a7b7ca">Actual SVG graph renderer · synthetic workspace data · no external actions</text></svg>`;
  await mkdir('docs/assets',{recursive:true});await writeFile('docs/assets/graph.svg',image);await writeFile('.ensemble/ui-snapshot.json',JSON.stringify(graph,null,2));console.log('Captured docs/assets/graph.svg from the native React graph.');
 }finally{await runtime.close();}
}finally{await rm(root,{recursive:true,force:true});}
