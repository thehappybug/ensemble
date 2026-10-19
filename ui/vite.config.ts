import { fileURLToPath } from 'node:url';
export default {root:fileURLToPath(new URL('.',import.meta.url)),base:'./',build:{outDir:'../dist/ui',emptyOutDir:true,target:'es2022'},server:{host:'127.0.0.1',port:5173,proxy:{'/api':{target:'http://127.0.0.1:4567',changeOrigin:false}}}};
