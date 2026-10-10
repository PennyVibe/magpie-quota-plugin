import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { win32 } from 'node:path';

type BrowserLaunchOptions = { timeout: number; killSignal: 'SIGKILL'; maxBuffer: number };
export type BrowserLauncher = (file: string, args: string[], options: BrowserLaunchOptions, callback: (error: Error | null) => void) => unknown;
export type BrowserSpawner = (file:string,args:string[],options:SpawnOptions)=>ChildProcess;

// 固定脚本从 stdin 读取已验证的 URL，令牌不进入命令行或脚本正文。
const windowsOpenScript = "$ErrorActionPreference='Stop'; try { $address=[Console]::In.ReadToEnd(); $start=New-Object System.Diagnostics.ProcessStartInfo; $start.FileName=$address; $start.UseShellExecute=$true; [void][System.Diagnostics.Process]::Start($start); exit 0 } catch { exit 1 }";
function openWindowsBrowser(address:string,launch:BrowserSpawner):Promise<boolean>{
 return new Promise(resolve=>{
  try{
   const executable=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
   const child=launch(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',windowsOpenScript],{stdio:['pipe','ignore','ignore'],windowsHide:true});
   let failed=false;
   const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');resolve(false);},5000);
   const fail=()=>{if(failed)return;failed=true;clearTimeout(timer);child.kill('SIGKILL');resolve(false);};
   child.on('error',fail);child.stdin?.on('error',fail);
   child.on('close',code=>{clearTimeout(timer);resolve(!failed&&code===0);});
   child.stdin?.end(address);
  }catch{resolve(false);}
 });
}

function validConnectionUrl(address: string, origin: string): boolean {
 const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin)?.[1];
 if (!port || Number(port) > 65535) return false;
 // 只接受当前连接服务签发的标准形式，拒绝别名、编码及额外参数。
 const prefix = `${origin}/connect?bootstrap=`;
 return address.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(address.slice(prefix.length));
}

/** 成功仅表示系统接受打开请求，不表示页面加载或登录完成。 */
export async function openConnectionBrowser(address: string, origin: string, options: { platform?: NodeJS.Platform; launch?: BrowserLauncher; spawn?: BrowserSpawner } = {}): Promise<boolean> {
 const platform=options.platform??process.platform;
 if (!['darwin','win32'].includes(platform) || !validConnectionUrl(address, origin)) return false;
 if(platform==='win32')return openWindowsBrowser(address,options.spawn??spawn);
 const launch: BrowserLauncher = options.launch ?? execFile;
 return new Promise(resolve => {
  try {
   // 不使用 shell，不记录含一次性凭据的 URL 或系统命令输出。
   launch('/usr/bin/open', [address], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 }, error => resolve(error === null));
  } catch { resolve(false); }
 });
}
