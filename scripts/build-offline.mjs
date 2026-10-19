// Optional verifier for restricted environments. Normal releases use `pnpm build`.
import {createRequire} from 'node:module';
import {realpath,mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
const require=createRequire(import.meta.url);
let esbuild;
try{esbuild=require('esbuild');}catch{
 const vitestRequire=createRequire(await realpath(new URL('../node_modules/vitest/package.json',import.meta.url)));
 esbuild=createRequire(vitestRequire.resolve('vite'))('esbuild');
}
await mkdir('dist/ui',{recursive:true});
await esbuild.build({entryPoints:['src/cli.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'dist/cli.js',sourcemap:true});
await chmod('dist/cli.js',0o755);
await esbuild.build({entryPoints:['ui/main.tsx'],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:'dist/ui/main.js',sourcemap:true,external:['@xyflow/react','@xyflow/react/*','@dagrejs/dagre','react-markdown','remark-gfm'],define:{'process.env.NODE_ENV':'"production"'}});
const html=(await readFile('ui/index.html','utf8')).replace(/<script[^>]+src=["'](?:\/)?(?:src\/)?main\.tsx["'][^>]*><\/script>/,'<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>');
await writeFile('dist/ui/index.html',html);
console.log('Built the CLI and native SVG UI from real cached dependencies. Optional graph-library imports remain external in this offline build.');
