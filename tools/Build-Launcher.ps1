<#
    Build-Launcher.ps1 —— 编译 GUI 启动器 DSH-start.exe

    产出：<项目根>\DSH-start.exe（WinExe 子系统，双击零闪窗）

    为什么不用 cmd / vbs：cmd 会闪 conhost；vbs 是安全软件的高敏特征。
    GUI 子系统的 exe 根本不创建控制台窗口，最干净。

    用法：pwsh -File tools\Build-Launcher.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $PSScriptRoot 'launcher\DSH-start.cs'
$out = Join-Path $root 'DSH-start.exe'
$work = Join-Path $PSScriptRoot 'launcher'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) { throw '找不到 csc.exe（.NET Framework 编译器）' }
if (-not (Test-Path -LiteralPath $src)) { throw "找不到源文件：$src" }

$version = '2.1.0.0'
$asmInfo = Join-Path $work 'AssemblyInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("DSH 控制台")]
[assembly: AssemblyDescription("dsh web 的浏览器版控制台")]
[assembly: AssemblyProduct("DSH 控制台")]
[assembly: AssemblyCompany("DSH-start")]
[assembly: AssemblyCopyright("Copyright © 2026")]
[assembly: AssemblyVersion("$version")]
[assembly: AssemblyFileVersion("$version")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content -LiteralPath $asmInfo -Encoding UTF8

$manifest = Join-Path $work 'app.manifest'
$iconFile = Join-Path $root 'app.ico'
if (-not (Test-Path -LiteralPath $iconFile)) { $iconFile = $null }
@'
<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="2.0.0.0" name="DSH.Start.Console" type="win32" />
  <description>dsh web console</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compat.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">permonitorv2,permonitor</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
                        version="6.0.0.0" processorArchitecture="*"
                        publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
'@ | Set-Content -LiteralPath $manifest -Encoding UTF8

if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/win32manifest:$manifest" `
    "/win32icon:$iconFile" `
    "/out:$out" `
    $src $asmInfo

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)) {
    throw "编译失败（exit $LASTEXITCODE）"
}

$fi = Get-Item -LiteralPath $out
$vi = $fi.VersionInfo

Write-Host ''
Write-Host ('已生成：{0}' -f $out) -ForegroundColor Green
Write-Host ('  大小     : {0:N0} 字节' -f $fi.Length)
Write-Host ('  产品名   : {0}' -f $vi.ProductName)
Write-Host ('  版本     : {0}' -f $vi.FileVersion)

$bytes = [IO.File]::ReadAllBytes($out)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 0x5C)
if ($subsystem -eq 2) {
    Write-Host '  PE 子系统: 2 (Windows GUI) —— 双击不会弹控制台' -ForegroundColor Green
} else {
    Write-Host "  PE 子系统: $subsystem —— 预期为 2，检查 /target:winexe" -ForegroundColor Red
}

Remove-Item -LiteralPath $asmInfo -Force -ErrorAction SilentlyContinue
