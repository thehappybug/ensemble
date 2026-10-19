// Compatibility declaration for the small picomatch surface used here.
declare module 'picomatch' {
 function picomatch(pattern:string|string[],options?:{dot?:boolean}):(input:string)=>boolean;
 export default picomatch;
}
