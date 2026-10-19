/** RFC 4180 CSV reader. Kept local so workspace discovery works without a research SDK. */
export function parseCSV(source:string):Record<string,string>[] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  const text=source.replace(/^\uFEFF/,'');
  function endCell():void {row.push(cell);cell='';closed=false;}
  function endRow():void {endCell();if(row.some(value=>value.trim()!==''))rows.push(row);row=[];}
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted) {
      if(char==='"') {if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}
      else cell+=char;
    } else if(char===',')endCell();
    else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;endRow();}
    else if(char==='"') {if(cell!==''||closed)throw new Error(`Unexpected quote in CSV at character ${i+1}`);quoted=true;}
    else {if(closed)throw new Error(`Unexpected character after closing CSV quote at character ${i+1}`);cell+=char;}
  }
  if(quoted)throw new Error('Unterminated quoted CSV field');
  if(cell!==''||row.length||closed)endRow();
  const header=rows.shift();
  if(!header?.length||header.some(name=>name.trim()===''))throw new Error('CSV requires a nonempty header row');
  if(new Set(header).size!==header.length)throw new Error('CSV requires distinct header names');
  return rows.map((values,index)=>{
    if(values.length!==header.length)throw new Error(`CSV row ${index+2} has ${values.length} fields; expected ${header.length}`);
    return Object.fromEntries(header.map((name,column)=>[name,values[column]]));
  });
}
