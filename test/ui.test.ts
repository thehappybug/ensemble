import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,expect,it } from 'vitest';
import { NativeGraph,layoutGraph } from '../ui/Graph.js';
import type { GraphData,GraphNode } from '../ui/types.js';
import { frontmatterSchema } from '../src/workspace/frontmatter.js';

function node(id:string,options:Partial<GraphNode>={}):GraphNode {return {id,path:id+'.prompt.md',kind:'prompt',fm:frontmatterSchema.parse({outputs:[id+'.md']}),body:'Prompt',inputs:[],inputPatterns:[],outputs:[id+'.md'],dependencies:[],fingerprint:'hash',status:'fresh',model:'mock',warnings:[],...options};}
function data(nodes:GraphNode[],edges:{source:string;target:string}[]=[]):GraphData {return {nodes,edges,files:['context/icp.md'],paused:false,costs:{llm:0,parallel:0}};}

describe('native dependency graph',()=>{
  it('lays out dependencies left to right with distinct grey source files',()=>{
    const graph=data([node('discover',{inputs:['context/icp.md']}),node('people',{inputs:['discover.md']}),node('direction',{inputs:['discover.md']}),node('ranking',{inputs:['people.md','direction.md']})],[{source:'discover',target:'people'},{source:'discover',target:'direction'},{source:'people',target:'ranking'},{source:'direction',target:'ranking'}]);
    const layout=layoutGraph(graph),byId=new Map(layout.nodes.map(node=>[node.id,node]));
    expect(byId.get('source:context/icp.md')?.kind).toBe('source');expect(byId.get('source:context/icp.md')?.status).toBe('source');
    for(const edge of layout.edges)expect(byId.get(edge.source)!.x+byId.get(edge.source)!.width).toBeLessThan(byId.get(edge.target)!.x);
    expect(byId.get('people')!.y).not.toBe(byId.get('direction')!.y);
  });
  it('collapses fan-out instances, merges edges, then expands each independent instance',()=>{
    const graph=data([node('top'),node('people[acme]',{path:'companies/each.prompt.md',instanceOf:'people',item:{_key:'acme'},inputs:['top.md'],status:'fresh'}),node('people[beta]',{path:'companies/each.prompt.md',instanceOf:'people',item:{_key:'beta'},inputs:['top.md'],status:'running'}),node('rank')],[{source:'top',target:'people[acme]'},{source:'top',target:'people[beta]'},{source:'people[acme]',target:'rank'},{source:'people[beta]',target:'rank'}]);
    const collapsed=layoutGraph(graph),group=collapsed.nodes.find(node=>node.kind==='group')!;expect(group.count).toBe(2);expect(group.status).toBe('running');expect(collapsed.edges).toHaveLength(2);
    const expanded=layoutGraph(graph,{expandedGroups:new Set(['people'])});expect(expanded.nodes.filter(node=>node.original?.instanceOf==='people')).toHaveLength(2);expect(expanded.nodes.some(node=>node.kind==='group')).toBe(false);
  });
  it('preserves context from outside a directory filter as boundary files',()=>{
    const graph=data([node('upstream'),node('topics/report',{inputs:['upstream.md']})],[{source:'upstream',target:'topics/report'}]);
    const layout=layoutGraph(graph,{directory:'topics'});expect(layout.nodes.some(node=>node.id==='upstream')).toBe(false);expect(layout.nodes.some(node=>node.sourcePath==='upstream.md')).toBe(true);expect(layout.nodes.some(node=>node.id==='topics/report')).toBe(true);
  });
  it('renders the actual accessible SVG with action approval, edited states, safe text and no foreignObject',()=>{
    const graph=data([node('report',{status:'modified',fm:frontmatterSchema.parse({outputs:['report.md'],description:'<script>unsafe</script>'})}),node('drafts',{kind:'action',path:'drafts.action.md',status:'awaiting-approval'})],[{source:'report',target:'drafts'}]);
    const svg=renderToStaticMarkup(React.createElement(NativeGraph,{data:graph}));
    expect(svg).toContain('<svg');expect(svg).toContain('role="button"');expect(svg).toContain('tabindex="0"');expect(svg).toContain('APPROVAL REQUIRED');expect(svg).toContain('awaiting approval');expect(svg).toContain('modified');expect(svg).toContain('&lt;script&gt;');expect(svg).not.toContain('<script>');expect(svg).not.toContain('foreignObject');
  });
});
