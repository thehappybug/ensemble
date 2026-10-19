const readVerbs=new Set(['LIST','GET','FETCH','FIND','SEARCH','READ']);
const writeVerbs=new Set(['CREATE','SEND','POST','UPDATE','DELETE','REMOVE','SET','ADD','UPLOAD','WRITE','INVITE','REPLY','FORWARD','EXECUTE','RUN','PUBLISH','ARCHIVE','UNARCHIVE','MODIFY','TRASH','UNTRASH','MARK','INSERT','PATCH','REPLACE','SCHEDULE','ATTACH','DETACH','IMPORT','COPY','MOVE','APPEND','CANCEL','REVOKE','GRANT','LINK','CONNECT']);
/** Conservative fallback for CLI schemas without readOnlyHint annotations. */
export function isReadOnlySlug(slug:string):boolean {
  if(slug.startsWith('COMPOSIO_')||!/^([A-Z0-9]+_)+[A-Z0-9]+$/.test(slug))return false;
  const tokens=slug.split('_').slice(1);
  return !tokens.some(token=>writeVerbs.has(token))&&tokens.some(token=>readVerbs.has(token));
}
