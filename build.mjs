//--------- LLVM Bindings Generator ---------//
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "fs/promises"
const execFile = promisify(execFileCb);

const includeFlags = [
  "-I",
  "llvm-project/llvm/include/",
  "-I",
  "build-emscripten/include",
];

const { stdout } = await execFile(
  "emcc",
  [
    "src/everything.c",
    "-O0",
    ...includeFlags,
    "-fsyntax-only",
    "-Xclang",
    "-ast-dump=json",
  ],
  {
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: undefined,
  }
);

//--- Extract all the nodes ---//
const parent = JSON.parse(stdout);
const nodeMap = new Map();
const visit = node => {
  nodeMap.set(node.id, node);
  if (node.inner) {
    for (const inner of node.inner) {
      visit(inner)
    }
  }
}
visit(parent);

const nodes = Array.from(nodeMap.values());

//--- Extract necessary information ---//
const filterOut = new Set([
  "_LLVMInitializeAllAsmParsers",
  "_LLVMInitializeAllAsmPrinters",
  "_LLVMInitializeAllDisassemblers",
  "_LLVMInitializeAllTargetInfos",
  "_LLVMInitializeAllTargetMCs",
  "_LLVMInitializeAllTargets",
  "_LLVMInitializeNativeAsmParser",
  "_LLVMInitializeNativeAsmPrinter",
  "_LLVMInitializeNativeDisassembler",
  "_LLVMInitializeNativeTarget",
]);

const added = ["_malloc", "_free"];
const typedefs = new Array();
const funcs = new Array();
const type_map = (qualType) => {
  switch(qualType)
  {
    case "char **":                            return "string[]";  break;
    case "const char *":                       return "string"; break;
    case "int":                                return "number"; break;
    case "unsigned int *":                     return "any"; break;
    case "char *":                             return "any"; break;
    case "void *":                             return "any"; break;
    case "unsigned int":                       return "number"; break;
    case "size_t":                             return "number"; break;
    case "uint64_t":                           return "number"; break;
    case "size_t *":                           return "any"; break;
    case "unsigned long long":                 return "number"; break;
    case "const uint64_t *":                   return "any"; break;
    case "uint8_t":                            return "number"; break;
    case "double":                             return "number"; break;
    case "int64_t":                            return "number"; break;
    case "uint32_t":                           return "number"; break;
    case "uint64_t *":                         return "any"; break;
    case "uint8_t":                            return "number"; break;
    case "struct LLVMMCJITCompilerOptions *":  return "any"; break;
    case "const char *const *":                return "any"; break;
    default:  return ("_"+qualType.split(' ')[0]); break;
  }
}

nodes.forEach(element => {
  if(!element?.name?.startsWith("LLVM"))  return;

  if(element?.kind == "TypedefDecl")
  {
    typedefs.push("_" + element.name);
  }
  else if(element?.kind == "FunctionDecl")
  {
    element.name = "_" + element.name;
    if(!filterOut.has(element.name))
      funcs.push(element);
    
    
    element.params = new Array();
    element.inner?.forEach(e => {
      if(e?.kind != "ParmVarDecl")  return;

      element.params.push({name: e.name, type: type_map(e.type.qualType)});
    });
    element.type = type_map(element.type.qualType);
  }
});

//--- Write Bindings and Typings ---//
let llvm_ts = "";
let llvm_exports = "";

//- Exported functions -//
llvm_exports = llvm_exports.concat("[");
added.forEach(element => {  llvm_exports = llvm_exports.concat("\""+element+"\","); });
funcs.forEach(element => {  llvm_exports = llvm_exports.concat("\""+element.name+"\","); });
llvm_exports = llvm_exports.slice(0, llvm_exports.length-1);
llvm_exports = llvm_exports.concat("]")

//- Header -//
llvm_ts = llvm_ts.concat("//@ts-ignore\n");
llvm_ts = llvm_ts.concat("import llvm from \"llvm.mjs\";\n");
llvm_ts = llvm_ts.concat("export default llvm as Promise<Module>;\n");
llvm_ts = llvm_ts.concat("const LLVM = await (llvm as Promise<Module>);\n");
llvm_ts = llvm_ts.concat("export type Pointer<T> = number & T;\n\n");

//- LLVM Struct Typings -//
typedefs.forEach(element => {
  llvm_ts = llvm_ts.concat("export type " + element + " = Pointer<{\n");
  llvm_ts = llvm_ts.concat("\ttype: \"" + element + "\";\n");
  llvm_ts = llvm_ts.concat("}>;\n");
});

llvm_ts = llvm_ts.concat("\nexport interface Module {\n\t");
llvm_ts = llvm_ts.concat("HEAPU8: Uint8Array;\n\t");
llvm_ts = llvm_ts.concat("HEAPU32: Uint32Array;\n\t");
llvm_ts = llvm_ts.concat("ready(): Promise<Module>\n\t");
llvm_ts = llvm_ts.concat("_LLVMModuleCreateWithName(name: LLVMStringRef): LLVMModuleRef;\n\t");
llvm_ts = llvm_ts.concat("_malloc<T>(size: number): Pointer<T>;\n\t");
llvm_ts = llvm_ts.concat("_free(ptr: Pointer<any>): void;\n");
llvm_ts = llvm_ts.concat("}\n\n");

//- LLVM Function Typings -//
funcs.forEach(element => {
  let func_proto = "";

  func_proto = func_proto.concat("export declare function " + element.name + "(");
  
  element.params.forEach(param => {
    func_proto = func_proto.concat(param.name + ": " + param.type + ", ");
  });
  if(element.params.length > 0) func_proto = func_proto.slice(0, func_proto.length-2);
  func_proto = func_proto.concat("): " + element.type+";\n");
  llvm_ts = llvm_ts.concat(func_proto);
});
llvm_ts = llvm_ts.concat("\n");

//- String lifting/lowering -//
llvm_ts = llvm_ts.concat("export function lower(str: string): LLVMStringRef {\n\t");
llvm_ts = llvm_ts.concat("str += \"0\";\n\t");
llvm_ts = llvm_ts.concat("const length = Buffer.byteLength(str);\n\t");
llvm_ts = llvm_ts.concat("const ptr = LLVM._malloc<{ type: \"LLVMStringRef\"; }>(length);\n\t");
llvm_ts = llvm_ts.concat("Buffer.from(LLVM.HEAPU8.buffer, ptr).write(str, \"utf-8\");\n\t");
llvm_ts = llvm_ts.concat("return ptr;\n");
llvm_ts = llvm_ts.concat("}\n\n");

llvm_ts = llvm_ts.concat("export function lift(ptr: Pointer<{ type: \"LLVMStringRef\"; }>): string {\n\t");
llvm_ts = llvm_ts.concat("const index = LLVM.HEAPU8.indexOf(0, ptr);\n\t");
llvm_ts = llvm_ts.concat("return Buffer.from(LLVM.HEAPU8.buffer).toString(\"utf-8\", ptr, index);\n");
llvm_ts = llvm_ts.concat("}\n\n");

//--- Write to respective files ---//
await writeFile("./build/llvm.d.ts", llvm_ts);
await writeFile("./llvm.exports", llvm_exports);