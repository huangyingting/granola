!macro customHeader
  !if "${APP_ID}" != "io.github.windowsainotes.desktop"
    !error "The installer identity must match the existing application."
  !endif
  !ifndef APP_64
    !error "The update installer requires an embedded x64 package."
  !endif
  !ifdef APP_32
    !error "Mixed-architecture update installers are not supported."
  !endif
  !ifdef APP_ARM64
    !error "Mixed-architecture update installers are not supported."
  !endif
  !ifdef APP_PACKAGE_URL
    !error "The update installer must not download an external package."
  !endif
  !ifdef APP_PACKAGE_STORE_FILE
    !error "The update installer must embed its complete package."
  !endif
  !ifdef BUILD_UNINSTALLER
    VIAddVersionKey /LANG=1033 InternalName "io.github.windowsainotes.desktop.uninstaller.x64.v1"
    VIAddVersionKey /LANG=1033 OriginalFilename "windows-ai-notes-${VERSION}-x64-uninstaller.exe"
  !else
    VIAddVersionKey /LANG=1033 InternalName "io.github.windowsainotes.desktop.nsis.x64.v1"
    VIAddVersionKey /LANG=1033 OriginalFilename "windows-ai-notes-${VERSION}-x64-setup.exe"
  !endif
!macroend
