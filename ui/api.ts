export async function api<T=unknown>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T> {
  const response=await fetch(path,{method:options.method??(options.body===undefined?'GET':'POST'),...(options.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(options.body)}),signal:options.signal});
  const contentType=response.headers.get('content-type')??'';
  const value:unknown=contentType.includes('application/json')?await response.json():await response.text();
  if(!response.ok)throw new Error(typeof value==='object'&&value&&'error' in value?String(value.error):typeof value==='string'?value:`Request failed (${response.status})`);
  return value as T;
}
export const nodePath=(id:string,suffix=''):string=>'/api/nodes/'+encodeURIComponent(id)+suffix;
export const actionPath=(id:string,suffix=''):string=>'/api/actions/'+encodeURIComponent(id)+suffix;
