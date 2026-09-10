Option Explicit

Dim fso, shell, exe, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
exe = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "opencomms.exe")

If Not fso.FileExists(exe) Then
  MsgBox "OpenComms is missing from its installation folder.", 16, "OpenComms"
  WScript.Quit 1
End If

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & Chr(34) & Replace(WScript.Arguments(i), Chr(34), Chr(34) & Chr(34)) & Chr(34)
Next

' Run the real CLI without a console window. The GUI chooses the project from
' its per-user workspace registry, never from this installation directory.
shell.CurrentDirectory = fso.GetParentFolderName(exe)
shell.Run Chr(34) & exe & Chr(34) & args, 0, False
