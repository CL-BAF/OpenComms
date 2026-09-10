; OpenComms per-user Windows installer.
; Build with Inno Setup 6 (ISCC.exe), after scripts/build-exe.mjs has created
; dist-release/opencomms.exe. No elevation is required and uninstall only
; removes files owned by this installation; project .opencomms data is never
; under {app} and is therefore preserved.

#define AppName "OpenComms"
#ifndef AppVersion
#define AppVersion "1.1.0"
#endif
#define AppPublisher "OpenComms"
#define AppExeName "opencomms.exe"

[Setup]
AppId={{B1E8B7CF-4A9D-4E16-9D3B-0000C0A22026}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\OpenComms
DefaultGroupName={#AppName}
DisableProgramGroupPage=no
PrivilegesRequired=lowest
OutputDir=..\dist-release
OutputBaseFilename=OpenComms-Setup-{#AppVersion}
SetupIconFile=..\assets\opencomms.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
ArchitecturesInstallIn64BitMode=x64
; Keep upgrades clean and do not use an elevation-only install mode.
UsePreviousAppDir=yes
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "addtopath"; Description: "Add opencomms.exe to the user PATH"; GroupDescription: "Integration options:"; Flags: unchecked

[Files]
Source: "..\dist-release\opencomms.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\opencomms.ico"; DestDir: "{app}"; DestName: "icon.ico"; Flags: ignoreversion
Source: "OpenComms.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\OpenComms"; Filename: "{sys}\wscript.exe"; Parameters: "{code:Quote|{app}\OpenComms.vbs} gui"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "OpenComms local session console"
Name: "{group}\Uninstall OpenComms"; Filename: "{uninstallexe}"; IconFilename: "{app}\icon.ico"; Comment: "Uninstall OpenComms without deleting project data"
Name: "{autodesktop}\OpenComms"; Filename: "{sys}\wscript.exe"; Parameters: "{code:Quote|{app}\OpenComms.vbs} gui"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon; Comment: "OpenComms local session console"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function Quote(Param: String): String;
begin
  Result := '"' + Param + '"';
end;

const
  EnvKey = 'Environment';
  MarkerKey = 'Software\OpenComms';
  MarkerValue = 'AddedPathByInstaller';

function PathEquals(A, B: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(Trim(A)), RemoveBackslashUnlessRoot(Trim(B))) = 0;
end;

function PathContains(Existing, Wanted: String): Boolean;
var
  Separator, Part: String;
begin
  Result := False;
  while Existing <> '' do begin
    Separator := ';';
    Part := Existing;
    if Pos(Separator, Existing) > 0 then begin
      Part := Copy(Existing, 1, Pos(Separator, Existing) - 1);
      Delete(Existing, 1, Pos(Separator, Existing));
    end else Existing := '';
    if PathEquals(Part, Wanted) then begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddUserPath;
var
  Existing, Parts: String;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Existing) then Existing := '';
  Parts := Existing;
  if not PathContains(Existing, ExpandConstant('{app}')) then begin
    if Parts <> '' then Parts := Parts + ';';
    Parts := Parts + ExpandConstant('{app}');
    RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Parts);
    RegWriteStringValue(HKCU, MarkerKey, MarkerValue, 'yes');
  end;
end;

procedure RemoveUserPath;
var
  Existing, Cleaned, Part: String;
  Separator: Integer;
begin
  if not RegQueryStringValue(HKCU, MarkerKey, MarkerValue, Part) then Exit;
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Existing) then Exit;
  Cleaned := '';
  while Existing <> '' do begin
    Separator := Pos(';', Existing);
    if Separator > 0 then begin
      Part := Copy(Existing, 1, Separator - 1);
      Delete(Existing, 1, Separator);
    end else begin
      Part := Existing;
      Existing := '';
    end;
    if not PathEquals(Part, ExpandConstant('{app}')) then begin
      if Cleaned <> '' then Cleaned := Cleaned + ';';
      Cleaned := Cleaned + Part;
    end;
  end;
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Cleaned);
  RegDeleteValue(HKCU, MarkerKey, MarkerValue);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then AddUserPath;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveUserPath;
end;
