declare module "@paperclipai/adapter-utils" {
  export interface AdapterSkillContext { agentId:string; companyId:string; adapterType:string; config:Record<string,unknown>; }
  export interface AdapterSkillEntry { key:string; runtimeName:string|null; desired:boolean; managed:boolean; required?:boolean; requiredReason?:string|null; state:any; origin?:any; originLabel?:string|null; locationLabel?:string|null; readOnly?:boolean; sourcePath?:string|null; targetPath?:string|null; detail?:string|null; }
  export interface AdapterSkillSnapshot { adapterType:string; supported:boolean; mode:any; desiredSkills:string[]; entries:AdapterSkillEntry[]; warnings:string[]; desiredSkillEntries?: any[]; }
  export interface AdapterExecutionContext {runId:string; agent:any; runtime:any; config:Record<string,unknown>; context:Record<string,unknown>; onLog:any; onMeta?:any; onEvent?:any; onRuntimeProgress?:any; onSpawn?:any; authToken?:string; executionTarget?:any; executionTransport?:any; runtimeCommandSpec?:any; runtimeMcp?:any; startupTraceContext?:any;}
  export interface AdapterExecutionResult {exitCode:number|null; signal:string|null; timedOut:boolean; errorMessage?:string|null; provider?:string|null; model?:string|null; summary?:string|null; usage?:any; biller?:string|null; billingType?:any; costUsd?:number|null; resultJson?:Record<string,unknown>|null;}
  export interface AdapterEnvironmentTestContext {companyId:string;adapterType:string;config:Record<string,unknown>;executionTarget?:any;environmentName?:string|null;deployment?:any;}
  export interface AdapterEnvironmentTestResult {adapterType:string;status:any;testedAt:string;checks:any[];}
  export interface ServerAdapterModule {type:string;execute(ctx:AdapterExecutionContext):Promise<AdapterExecutionResult>;testEnvironment(ctx:AdapterEnvironmentTestContext):Promise<AdapterEnvironmentTestResult>;models?:any[];listModels?:()=>Promise<any[]>;refreshModels?:()=>Promise<any[]>;agentConfigurationDoc?:string;listSkills?:any;syncSkills?:any;supportsInstructionsBundle?:boolean;instructionsPathKey?:string;requiresMaterializedRuntimeSkills?:boolean;getConfigSchema?:any;}
  export const inferOpenAiCompatibleBiller: any;
}
declare module "@paperclipai/adapter-utils/server-utils" {
  export const asNumber:any; export const asString:any; export const parseObject:any;
  export const readPaperclipRuntimeSkillEntries:any;
  export const resolvePaperclipDesiredSkillNames:any;
  export const buildRuntimeMountedSkillSnapshot:any;
}
