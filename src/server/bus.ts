import {EventEmitter} from 'node:events';
export interface WorkspaceEvent {type:string;at:string;data:Record<string,unknown>}
export class EventBus {
 private emitter=new EventEmitter();history:WorkspaceEvent[]=[];
 emit(type:string,data:Record<string,unknown>={}){const event={type,at:new Date().toISOString(),data};this.history.push(event);if(this.history.length>500)this.history.shift();this.emitter.emit('event',event);return event;}
 subscribe(fn:(e:WorkspaceEvent)=>void){this.emitter.on('event',fn);return ()=>{this.emitter.off('event',fn);};}
}
