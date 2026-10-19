import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

// Read-only screenshots of the actual daemon. No app action or model call is made.
const repo=fileURLToPath(new URL('..',import.meta.url));
const base=process.env.ENSEMBLE_SCREENSHOT_URL??'http://127.0.0.1:4568';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Capture a local workspace only');
const graph=await(await fetch(base+'/api/graph')).json();
assert.equal(graph.simulated,false,'Live screenshots require a non-simulated workspace');
assert(graph.nodes.some(node=>node.status==='fresh'),'Run research before capturing live screenshots');
const destination=path.join(repo,'docs/assets/live');await mkdir(destination,{recursive:true});
const browser=await chromium.launch({headless:true});
const failures=[],mutations=[],screenshots=[];
const page=await browser.newPage({viewport:{width:1720,height:1120},deviceScaleFactor:1});
page.on('pageerror',error=>failures.push(error.message));
await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){mutations.push(route.request().method());return route.abort();}return route.continue();});
async function privacy(){
 await page.evaluate(()=>{
  const redact=value=>value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email hidden]').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'[identifier hidden]').replace(/\/(?:home|Users)\/[^\s<>`"']+/g,'[local path hidden]');
  const sanitize=()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){if(node.parentElement?.closest('script,style'))continue;const next=redact(node.nodeValue??'');if(next!==node.nodeValue)node.nodeValue=next;}};
  sanitize();window.__ensemblePrivacyObserver?.disconnect();window.__ensemblePrivacyObserver=new MutationObserver(sanitize);window.__ensemblePrivacyObserver.observe(document.body,{subtree:true,characterData:true,childList:true});
 });
 assert.equal(await page.locator('body').innerText().then(text=>/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)),false,'Visible email was not redacted');
}
async function capture(file,label,locator,fullPage=false){
 await privacy();const options={path:path.join(destination,file),animations:'disabled',caret:'hide'};
 if(locator)await locator.screenshot(options);else await page.screenshot({...options,fullPage});
 screenshots.push({file,label});console.log('Captured '+file);
}
async function flow(){await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Research flow.'}).waitFor();assert.equal(await page.locator('.simulation-banner').count(),0);}
try{
 await flow();
 await capture('overview.png','Completed live dependency graph with an action awaiting approval');
 while(await page.locator('.graph-node-group').count())await page.locator('.graph-node-group').first().click();
 await capture('fan-out.png','Expanded live company instances and their independent dependencies',undefined,true);
 await flow();
 await page.locator('.graph-node-group').filter({hasText:'icp fit'}).click();
 const fit=graph.nodes.find(node=>node.id.includes('/icp-fit[')&&node.status==='fresh');assert(fit?.item?.company_name,'A completed per-company fit report is required');
 await page.locator('.graph-node-prompt').filter({hasText:fit.item.company_name}).click();
 const drawer=page.getByRole('dialog');await drawer.waitFor();await drawer.getByRole('button',{name:'Outputs',exact:true}).click();await drawer.locator('.markdown h1').waitFor();
 await capture('report.png','Generated prospect qualification report in the node output drawer',drawer);
 await page.getByRole('button',{name:'Close node details',exact:true}).click();
 await page.getByRole('button',{name:/^Approvals\s+\d+$/,exact:true}).click();await page.locator('.email-card').first().waitFor();
 await capture('approvals.png','Exact live plan with readable draft recipients, subjects and bodies');
 await page.locator('.review-controls').scrollIntoViewIfNeeded();await capture('approval-controls.png','Linear ticket and explicit approval, dry-run, edit and reject controls');
 await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByText('Run completed',{exact:true}).first().waitFor();await page.evaluate(()=>window.scrollTo(0,0));
 await capture('activity.png','Actual completed runs, summaries and per-run git commit links');
 await page.getByRole('button',{name:'Files',exact:true}).click();await page.locator('.file-row').filter({hasText:'context/company.md'}).click();await page.locator('.file-viewer .markdown h1').waitFor();await page.evaluate(()=>window.scrollTo(0,0));
 await capture('context.png','Workspace file browser with the APIMatic product context');
 assert.deepEqual(mutations,[],'Screenshots must not mutate the workspace');assert.deepEqual(failures,[],'Browser errors during capture');
 const companies=[...new Set(graph.nodes.filter(node=>node.item).map(node=>node.item.company_name))];
 await writeFile(path.join(destination,'capture.json'),JSON.stringify({capturedAt:new Date().toISOString(),mode:'live',viewport:{width:1720,height:1120},companies,nodeCount:graph.nodes.length,approvalState:graph.nodes.find(node=>node.kind==='action')?.status,redactions:'Email addresses, UUID identifiers and local home-directory paths were replaced in the browser DOM for public screenshots only. Workspace files and plans were unchanged.',readOnly:true,screenshots},null,2)+'\n');
}finally{await browser.close();}
