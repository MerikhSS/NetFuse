# Custom NSIS hooks, picked up automatically by electron-builder from build/installer.nsh.

# NSIS adds the last folder of InstallDir to any folder picked with Browse, so choosing D:\ shows
# D:\NetFuse straight away rather than leaving people to make and name the folder themselves.
# electron-builder sets no InstallDir of its own (multiUser.nsh picks the folder at launch, which
# still decides where it goes), so without this, Browse adds nothing.
!macro customHeader
  InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!macroend

# Replaces electron-builder's default finish page (assistedInstaller.nsh) to add a
# "Create a desktop shortcut" checkbox, checked by default. The install step has already created
# the shortcut (createDesktopShortcut in electron-builder.yml), so the checkbox only decides whether
# it stays: unchecked deletes it, checked recreates it if an earlier install left it missing.
# Silent installs and auto-updates skip this page and keep the default behaviour.
!macro customFinishPage
  # Same "Run NetFuse" checkbox as the default finish page.
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  # MUI only offers a "Show Readme" checkbox here; we relabel it and point it at our function.
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE "RemoveDesktopShortcutIfUnchecked"

  !insertmacro MUI_PAGE_FINISH

  # Defined after MUI_PAGE_FINISH because that is what declares $mui.FinishPage.ShowReadme.

  # Called by the finish page only when the checkbox is checked.
  Function CreateDesktopShortcut
    ${ifNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
  FunctionEnd

  # Runs when the user clicks Finish, before the checkbox actions above.
  Function RemoveDesktopShortcutIfUnchecked
    ${NSD_GetState} $mui.FinishPage.ShowReadme $0
    ${if} $0 <> ${BST_CHECKED}
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
  FunctionEnd
!macroend
