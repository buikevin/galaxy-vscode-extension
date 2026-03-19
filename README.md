# Galaxy Code

Galaxy Code is a VS Code sidebar assistant for day-to-day coding work.

It helps you read code, make edits, work with project context, and build UI faster inside your current workspace.

## What It Is For

Galaxy Code is designed for common development tasks such as:

- understanding an existing codebase
- editing and generating code
- working with project files and documents
- helping with frontend implementation
- supporting Figma-to-code workflows

## How To Use

Open the `Galaxy Code` sidebar in VS Code and start chatting about the code in your current workspace.

You can use it to:

- ask questions about the project
- request code changes
- attach files or design context
- iterate on UI and implementation details

Available commands:

- `Galaxy Code: Focus Chat`
- `Galaxy Code: Clear Chat History`
- `Galaxy Code: Open Config Folder`

Default shortcut:

- `Cmd+Shift+G` on macOS
- `Ctrl+Shift+G` on Windows/Linux

## Design Support

Galaxy Code supports design-driven development workflows, including Figma-based implementation help for UI work.

## Built With Galaxy Design

This project supports [Galaxy Design](https://galaxy-design.vercel.app/), a design system and component library for building modern interfaces.

Galaxy Design is integrated directly into Galaxy Code.

If your project uses Galaxy Design, Galaxy Code can help you work with that setup directly inside VS Code.

## Notes

- Galaxy Code works best when opened in a real workspace folder.
- Large documents and design inputs are handled progressively to keep the chat usable.
- Some project actions may require confirmation before execution.
