import React,{ useEffect,useMemo,useState,type ComponentType } from 'react';
import type { GraphData,GraphNode,NodeStatus } from './types.js';

export interface VisualNode {id:string;label:string;subtitle:string;kind:'source'|'prompt'|'action'|'group'|'fanout';status:NodeStatus|'source';original?:GraphNode;sourcePath?:string;groupId?:string;count?:number;x:number;y:number;width:number;height:number}
export interface GraphLayout {nodes:VisualNode[];edges:{source:string;target:string}[];width:number;height:number}
const priority:(NodeStatus|'source')[]=['running','executing','failed','invalid','awaiting-approval','queued','stale','modified','blocked','pending-expansion','fresh','source'];
export const stateColor:Record<NodeStatus|'source',string>={fresh:'#75d9ac',stale:'#e9bc64',queued:'#86b9fc',running:'#7eb6ff',failed:'#f47e89','awaiting-approval':'#bba1ff',modified:'#6ce1da',invalid:'#838b9b',blocked:'#838b9b','pending-expansion':'#8d97ab',executing:'#7eb6ff',source:'#929bad'};
const basename=(value:string)=>value.split('/').at(-1)??value;
function title(node:GraphNode):string {return basename(node.path).replace(/\.(prompt|action)\.md$/,'').replace(/-/g,' ');}
export function layoutGraph(data:GraphData,options:{directory?:string;expandedGroups?:Set<string>}={}):GraphLayout {
  const nodes:VisualNode[]=[],edges:{source:string;target:string}[]=[],mapping=new Map<string,string>(),expanded=options.expandedGroups??new Set<string>();
  const included=data.nodes.filter(node=>!options.directory||node.path.startsWith(options.directory+'/')||node.path===options.directory);
  const groups=new Map<string,GraphNode[]>();for(const node of included)if(node.instanceOf&&!expanded.has(node.instanceOf))groups.set(node.instanceOf,[...(groups.get(node.instanceOf)??[]),node]);
  const create=(node:GraphNode):VisualNode=>({id:node.id,label:node.item?String(node.item.company_name??node.item.name??node.item._key):title(node),subtitle:node.item?title(node):node.fm.description??node.path,kind:node.kind,status:node.status,original:node,x:0,y:0,width:224,height:106});
  for(const node of included) {
    if(node.instanceOf&&!expanded.has(node.instanceOf)){mapping.set(node.id,'group:'+node.instanceOf);continue;}
    nodes.push(create(node));mapping.set(node.id,node.id);
  }
  for(const [groupId,instances] of groups) {
    const status=priority.find(status=>instances.some(node=>node.status===status)) as NodeStatus;
    nodes.push({id:'group:'+groupId,label:title(instances[0]),subtitle:instances[0].fm.description??`${instances.length} independent instances`,kind:'group',status,original:instances[0],groupId,count:instances.length,x:0,y:0,width:224,height:106});
  }
  const edgeKeys=new Set<string>();const connect=(source:string,target:string)=>{const key=source+'→'+target;if(source!==target&&!edgeKeys.has(key)){edges.push({source,target});edgeKeys.add(key);}};
  for(const edge of data.edges){const source=mapping.get(edge.source),target=mapping.get(edge.target);if(source&&target)connect(source,target);}
  const owners=new Map<string,string[]>();for(const node of data.nodes)for(const output of node.outputs)owners.set(output,[...(owners.get(output)??[]),node.id]);
  const sourceNodes=new Map<string,VisualNode>();
  for(const node of included)for(const file of [...node.inputs,...(node.foreachSource?[node.foreachSource]:[])]) {
    const target=mapping.get(node.id)!;
    const visibleOwners=(owners.get(file)??[]).map(owner=>mapping.get(owner)).filter((owner):owner is string=>!!owner);
    if(visibleOwners.length){for(const owner of visibleOwners)connect(owner,target);continue;}
    if(!sourceNodes.has(file))sourceNodes.set(file,{id:'source:'+file,label:basename(file),subtitle:file,kind:'source',status:'source',sourcePath:file,x:0,y:0,width:184,height:66});
    connect('source:'+file,target);
  }
  nodes.unshift(...sourceNodes.values());
  const byId=new Map(nodes.map(node=>[node.id,node])),indegree=new Map(nodes.map(node=>[node.id,0])),ranks=new Map(nodes.map(node=>[node.id,0]));
  for(const edge of edges)indegree.set(edge.target,(indegree.get(edge.target)??0)+1);
  const ready=nodes.filter(node=>!indegree.get(node.id)).map(node=>node.id);let count=0;
  while(ready.length&&count++<nodes.length+1){const id=ready.shift()!;for(const edge of edges.filter(edge=>edge.source===id)){ranks.set(edge.target,Math.max(ranks.get(edge.target)??0,(ranks.get(id)??0)+1));indegree.set(edge.target,indegree.get(edge.target)!-1);if(!indegree.get(edge.target))ready.push(edge.target);}}
  const columns=new Map<number,VisualNode[]>();for(const node of nodes){const rank=ranks.get(node.id)??0;columns.set(rank,[...(columns.get(rank)??[]),node]);}
  const heights=[...columns.values()].map(column=>column.reduce((sum,node)=>sum+node.height+24,0)-24),height=Math.max(460,...heights)+96;
  for(const [rank,column] of columns){column.sort((a,b)=>{const pa=edges.filter(e=>e.target===a.id).reduce((sum,e)=>sum+(byId.get(e.source)?.y??0),0),pb=edges.filter(e=>e.target===b.id).reduce((sum,e)=>sum+(byId.get(e.source)?.y??0),0);return pa-pb||a.label.localeCompare(b.label);});let y=(height-(column.reduce((sum,node)=>sum+node.height+24,0)-24))/2;for(const node of column){node.x=48+rank*292;node.y=y;y+=node.height+24;}}
  const width=Math.max(820,...nodes.map(node=>node.x+node.width+48));return {nodes,edges,width,height};
}
function short(value:string,max:number):string {return value.length>max?value.slice(0,max-1)+'…':value;}
function wrapped(value:string,max=30):string[] {const words=value.split(/\s+/),lines:string[]=[];let current='';for(const word of words){if((current+' '+word).trim().length>max&&current){lines.push(current);current=word;}else current=(current+' '+word).trim();if(lines.length===2)break;}if(lines.length<2&&current)lines.push(short(current,max));return lines;}
export interface NativeGraphProps {data:GraphData;directory?:string;expandedGroups?:Set<string>;onToggleGroup?:(id:string)=>void;onSelect?:(node:GraphNode)=>void;onFile?:(path:string)=>void;selectedId?:string;zoom?:number}
export function NativeGraph({data,directory,expandedGroups,onToggleGroup,onSelect,onFile,selectedId,zoom=1}:NativeGraphProps) {
  const layout=layoutGraph(data,{directory,expandedGroups}),byId=new Map(layout.nodes.map(node=>[node.id,node]));
  const activate=(node:VisualNode)=>{if(node.groupId)onToggleGroup?.(node.groupId);else if(node.sourcePath)onFile?.(node.sourcePath);else if(node.original)onSelect?.(node.original);};
  return <svg className="graph-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Workspace dependency graph. Select a step to inspect its prompt, outputs and run history." viewBox={`0 0 ${layout.width} ${layout.height}`} style={{minWidth:Math.min(layout.width,1080)*zoom,width:`${zoom*100}%`,height:Math.max(460,layout.height*.82)*zoom}}>
    <defs><pattern id="ensemble-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#606c82" opacity=".24"/></pattern><marker id="ensemble-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#576479"/></marker><filter id="ensemble-glow"><feGaussianBlur stdDeviation="4"/></filter></defs>
    <rect width={layout.width} height={layout.height} fill="#10151e"/><rect width="100%" height="100%" fill="url(#ensemble-grid)"/>
    {layout.edges.map(edge=>{const a=byId.get(edge.source)!,b=byId.get(edge.target)!;const x=a.x+a.width,y=a.y+a.height/2,tx=b.x,ty=b.y+b.height/2,mid=(x+tx)/2;return <path key={edge.source+'>'+edge.target} className={`graph-edge ${['stale','running','queued'].includes(b.status)?'graph-edge-active':''}`} d={`M${x} ${y} C${mid} ${y},${mid} ${ty},${tx-7} ${ty}`} fill="none" stroke={['stale','running','queued'].includes(b.status)?stateColor[b.status]:'#485366'} strokeWidth="1.5" strokeOpacity=".65" markerEnd="url(#ensemble-arrow)"/>;})}
    {layout.nodes.map(node=>{const color=stateColor[node.status],source=node.kind==='source',selected=selectedId===node.id||selectedId===node.original?.id;return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.label}, ${node.kind==='group'?node.count+' instances, ':''}${node.status}`} className={`graph-node graph-node-${node.kind} graph-state-${node.status}${selected?' graph-selected':''}`} onClick={()=>activate(node)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate(node);}}}>
      <title>{node.subtitle+(node.original?.reason?' — '+node.original.reason:'')}</title>
      {node.kind==='group'&&<><rect x={node.x+8} y={node.y-8} width={node.width-16} height={node.height} rx="12" fill="#171e2b" stroke="#3a465e"/><rect x={node.x+4} y={node.y-4} width={node.width-8} height={node.height} rx="12" fill="#171e2b" stroke="#3a465e"/></>}
      {node.kind==='action'?<path d={`M${node.x+14} ${node.y} H${node.x+node.width-14} L${node.x+node.width} ${node.y+14} V${node.y+node.height-14} L${node.x+node.width-14} ${node.y+node.height} H${node.x+14} L${node.x} ${node.y+node.height-14} V${node.y+14} Z`} fill="#1b192d" stroke={selected?color:'#50436d'} strokeWidth={selected?2:1}/>:<rect x={node.x} y={node.y} width={node.width} height={node.height} rx={source?9:12} fill={source?'#171d27':'#1b2331'} stroke={selected?color:source?'#354052':'#3b495f'} strokeWidth={selected?2:1}/>}
      {!source&&<rect x={node.x} y={node.y+14} width="3" height={node.height-28} rx="1.5" fill={color}/>}
      <text x={node.x+16} y={node.y+22} fill={source?'#8c99ad':'#a3b1c6'} fontFamily="system-ui,sans-serif" fontSize="9" fontWeight="600" letterSpacing="1.1">{source?'SOURCE FILE':node.kind==='group'?'FAN-OUT · '+node.count+' INSTANCES':node.kind==='action'?'APPROVAL REQUIRED':node.kind==='fanout'?'FAN-OUT':'PROMPT'}{node.kind==='group'?'  ↗':''}</text>
      <text x={node.x+16} y={node.y+(source?44:45)} fill="#f1f4fa" fontFamily="system-ui,sans-serif" fontSize={source?12:14} fontWeight="600">{short(node.label,source?23:27)}</text>
      {!source&&wrapped(node.subtitle,33).slice(0,1).map((line,index)=><text key={index} x={node.x+16} y={node.y+64+index*12} fill="#8f9db3" fontFamily="system-ui,sans-serif" fontSize="10">{line}</text>)}
      {!source&&<><circle className={['running','executing'].includes(node.status)?'graph-running-dot':''} cx={node.x+20} cy={node.y+85} r="3" fill={color}/><text x={node.x+29} y={node.y+88} fill={color} fontFamily="system-ui,sans-serif" fontSize="10">{node.status==='awaiting-approval'?'awaiting approval':node.status==='pending-expansion'?'waiting for dataset':node.status}</text>{node.kind==='group'&&<text x={node.x+node.width-17} y={node.y+88} fill="#a7b8d1" fontSize="10" textAnchor="end" fontFamily="system-ui,sans-serif">expand +</text>}</>}
    </g>;})}
    {!layout.nodes.length&&<text x={layout.width/2} y={layout.height/2} fill="#8c99ad" textAnchor="middle" fontFamily="system-ui,sans-serif">Add a .prompt.md file to connect your first step.</text>}
  </svg>;
}
interface FlowProps {nodes:unknown[];edges:unknown[];fitView:boolean;nodesDraggable:boolean;nodesConnectable:boolean;onNodeClick:(event:unknown,node:{id:string})=>void;children?:React.ReactNode}
interface FlowModule {ReactFlow:ComponentType<FlowProps>;Background:ComponentType<Record<string,unknown>>;Controls:ComponentType<Record<string,unknown>>}
export default function Graph(props:NativeGraphProps) {
  const [expanded,setExpanded]=useState<Set<string>>(new Set()),[zoom,setZoom]=useState(1),[engine,setEngine]=useState<'map'|'interactive'>('map'),[flow,setFlow]=useState<FlowModule|null>(null);
  useEffect(()=>{let mounted=true;void import('@xyflow/react').then(async module=>{await import('@xyflow/react/dist/style.css');if(mounted)setFlow(module as unknown as FlowModule);}).catch(()=>{});return ()=>{mounted=false;};},[]);
  const layout=useMemo(()=>layoutGraph(props.data,{directory:props.directory,expandedGroups:expanded}),[props.data,props.directory,expanded]);
  const toggle=(id:string)=>setExpanded(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const Flow=flow?.ReactFlow,Background=flow?.Background,Controls=flow?.Controls;
  const groups=[...new Set(props.data.nodes.map(node=>node.instanceOf).filter((id):id is string=>!!id))];
  return <div className="graph-panel"><div className="graph-panel-top"><div><span className="eyebrow">DEPENDENCY MAP</span><span className="graph-hint">Changes flow from left to right</span></div><div className="graph-controls">{flow&&<button className="button button-subtle button-small" onClick={()=>setEngine(engine==='map'?'interactive':'map')}>{engine==='map'?'Pan & zoom':'Overview'}</button>}{engine==='map'&&<><button className="icon-button" aria-label="Zoom out" onClick={()=>setZoom(value=>Math.max(.65,value-.15))}>−</button><button className="button button-subtle button-small" onClick={()=>setZoom(1)}>Fit</button><button className="icon-button" aria-label="Zoom in" onClick={()=>setZoom(value=>Math.min(2,value+.15))}>+</button></>}</div></div>
    <div className="graph-canvas">{engine==='interactive'&&Flow?<div style={{height:Math.max(500,layout.height*.8)}}><Flow fitView nodesDraggable={false} nodesConnectable={false} nodes={layout.nodes.map(node=>({id:node.id,position:{x:node.x,y:node.y},data:{label:<div className="flow-card"><small>{node.kind==='source'?'SOURCE':node.kind.toUpperCase()}</small><strong>{node.label}</strong><span style={{color:stateColor[node.status]}}>{node.status}{node.count?' · '+node.count+' instances':''}</span></div>},style:{width:node.width,background:'#1b2331',color:'#f1f4fa',border:'1px solid '+stateColor[node.status],borderRadius:12,padding:12},sourcePosition:'right',targetPosition:'left'}))} edges={layout.edges.map((edge,index)=>({...edge,id:'edge'+index,animated:['running','stale'].includes(layout.nodes.find(node=>node.id===edge.target)?.status??''),style:{stroke:'#6b8d9d'}}))} onNodeClick={(_event,selected)=>{const node=layout.nodes.find(node=>node.id===selected.id);if(node?.groupId)toggle(node.groupId);else if(node?.sourcePath)props.onFile?.(node.sourcePath);else if(node?.original)props.onSelect?.(node.original);}}>{Background&&<Background color="#334052" gap={20}/>} {Controls&&<Controls/>}</Flow></div>:<NativeGraph {...props} expandedGroups={expanded} onToggleGroup={toggle} zoom={zoom}/>}</div>
    <div className="graph-footer"><div className="graph-legend">{(['fresh','stale','running','awaiting-approval','modified','failed'] as const).map(status=><span key={status}><i style={{background:stateColor[status]}}/>{status==='awaiting-approval'?'approval':status==='modified'?'edited':status}</span>)}</div>{groups.length>0&&<div className="group-controls">{groups.map(id=><button key={id} className="group-toggle" onClick={()=>toggle(id)}>{expanded.has(id)?'−':'+'} {basename(id).replace(/-/g,' ')}</button>)}</div>}</div>
  </div>;
}
