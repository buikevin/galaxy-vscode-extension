# Galaxy VS Code UI Shell Refactor Plan

## Mục tiêu

Tài liệu này tổng hợp định hướng thay đổi giao diện cho `galaxy-vscode-extension` theo hướng:

- Giữ `webview` cho chat experience cốt lõi.
- Tăng dùng `VS Code shell` cho các workflow phụ trợ.
- Tránh rewrite toàn bộ extension sang native chat UI của VS Code.

Mục tiêu cuối là làm UI tự nhiên hơn trong VS Code, giảm phần việc không cần thiết trong webview, nhưng vẫn giữ được trải nghiệm Galaxy riêng.

## Trạng thái hiện tại

Tính đến vòng refactor hiện tại:

- Phase 1 đã hoàn thành
- Phase 2 đã hoàn thành
- Phase 3 đã hoàn thành

Phần đã đi vào code:

- Runtime logs đã có `OutputChannel`
- Agent switch đã có `QuickPick` và `StatusBarItem`
- Progress/error/approval đã có native notifications
- `Context Files` và `Changed Files` đã chuyển sang `TreeView`
- Review file-level đã ưu tiên `vscode.diff`
- Approval flow đã chuyển sang hybrid
- Quality toggles đã sync với command palette và VS Code settings

## VS Code shell là gì

`VS Code shell` không phải là tên một library chính thức. Đây là cách gọi phần khung UI native mà VS Code cung cấp sẵn cho extension.

Ví dụ:

- Activity bar
- Sidebar
- Panel
- Editor tabs
- Diff editor
- Tree view
- Quick pick
- Command palette
- Status bar
- Output channel
- Terminal
- Notifications
- Progress UI
- Native chat panel của VS Code

Hiểu ngắn gọn:

- `VS Code shell` = vỏ UI native của VS Code
- `webview custom UI` = app HTML/CSS/JS riêng của extension, nhúng vào shell đó

## Hiện trạng của Galaxy

`galaxy-vscode-extension` hiện là kiến trúc `webview-first`.

Điểm neo trong code:

- View container và view kiểu `webview` được khai báo trong `package.json`
- Sidebar chính dùng `WebviewViewProvider` trong `src/extension.ts`
- Review panel dùng `createWebviewPanel(...)`
- UI chat được render bằng React trong `webview/src/main.tsx`

Nói ngắn gọn:

- Shell hiện tại: activity bar container, command registration, panel host của VS Code
- Custom UI hiện tại: gần như toàn bộ chat, file selection, logs, approval, quality, review summary

## So sánh kiến trúc với các sản phẩm khác

| Sản phẩm | Màn chat chính | Phần là VS Code shell | Phần là webview custom UI | Dấu vết kỹ thuật |
| --- | --- | --- | --- | --- |
| GitHub Copilot Chat | Native chat của VS Code | Chat panel, editor chat, editing session | Rất ít bằng chứng cho webview chính của chat | Dùng `onLanguageModelChat` và `chatParticipants` |
| OpenAI/Codex | Sidebar riêng | Activity bar, secondary sidebar, chat session registration | Rõ ràng là app frontend riêng | Webview + React |
| Gemini Code Assist | Sidebar riêng | Activity bar container, command integration | Rõ ràng là app frontend riêng | Webview + Angular/Angular Material |
| Galaxy VS Code | Sidebar chat riêng | Activity bar, commands, panel host | Hiện tại là phần lớn trải nghiệm | Webview + React |

## Kết luận kiến trúc cho Galaxy

Galaxy không nên chuyển toàn bộ sang mô hình của Copilot.

Hướng phù hợp hơn là:

- Giữ `webview` cho chat transcript, composer, thinking, tool cards, attachment preview
- Chuyển các phần phụ trợ sang primitive native của VS Code khi primitive đó mạnh hơn webview

Đây là hướng `hybrid`.

## Bảng đề xuất thay đổi giao diện

| Khu vực | Hiện tại | Đề xuất | Primitive VS Code | Ưu tiên | Effort | Lý do |
| --- | --- | --- | --- | --- | --- | --- |
| Chat transcript + composer + thinking/tool cards | Webview React | Giữ nguyên trong webview | `WebviewView` | Rất cao | Không làm | Đây là core UX riêng của Galaxy, chuyển native sẽ mất nhiều quyền kiểm soát layout và luồng tool |
| File/context picker | Chọn file trong webview qua `selectedFiles` và `file-toggle` | Chuyển sang `TreeView` native, webview chỉ hiển thị context đã chọn | `TreeDataProvider`, `TreeView` | Cao | Trung bình | Chọn file là tác vụ rất hợp với shell native hơn webview |
| Runtime logs | Đẩy `logs-updated` vào webview | Chuyển log đầy đủ sang `OutputChannel`, webview chỉ giữ summary gần nhất | `OutputChannel` | Cao | Thấp | Log dài trong webview vừa nặng vừa khó scan |
| Shell command stream | Render live panel trong webview | Giữ preview ngắn trong webview, thêm tùy chọn mở terminal/output native | `Terminal`, `OutputChannel` | Cao | Trung bình | Lệnh shell là thứ user kỳ vọng xem ở terminal hơn |
| Change review | Có summary + review panel webview | Giữ summary trong webview, nhưng diff/review file mở bằng diff editor native | `vscode.diff`, editor tabs | Cao | Trung bình | So sánh code trong editor native tốt hơn hẳn webview |
| Approval flow | Approval trong webview | Hybrid: approval đơn giản dùng native prompt, approval chi tiết/nguy hiểm vẫn ở webview | `showInformationMessage`, `showWarningMessage`, `QuickPick` | Trung bình | Trung bình | Native prompt nhanh hơn cho case nhỏ, webview tốt hơn cho case nhiều chi tiết |
| Agent/model picker | Dropdown trong webview | Chuyển sang command + quick pick, có thể thêm status bar | `QuickPick`, `StatusBarItem` | Cao | Thấp | Đây là control toàn cục, không nhất thiết phải nằm trong chat UI |
| Review/validate toggles | Toggle trong webview | Đồng bộ thêm vào settings và command palette | `workspace.getConfiguration`, commands | Trung bình | Thấp | Đây là preference, hợp với hệ settings của VS Code |
| Notifications trạng thái | Chủ yếu nằm trong webview | Thêm native progress + notifications | `withProgress`, `showErrorMessage`, `showWarningMessage` | Cao | Thấp | Fail, done, waiting approval nên nổi ở shell |
| Figma preview / rich attachment | Webview | Giữ trong webview | `WebviewView` | Cao | Không làm | Preview ảnh/tài liệu là case mạnh của webview |
| Session history / task list | Chủ yếu trong transcript | Có thể thêm tree/list native nếu cần quản lý nhiều task | `TreeView` | Thấp | Trung bình | Chỉ nên làm khi session management phức tạp hơn |
| Review panel riêng | Có `createWebviewPanel(...)` | Giảm vai trò panel này, ưu tiên editor diff native | `WebviewPanel` + `vscode.diff` | Trung bình | Trung bình | Webview panel review dễ đẹp nhưng editor native mạnh hơn cho code review |

## Đề xuất cấu trúc UI sau refactor

### Giữ trong webview

- Chat transcript
- Composer
- Thinking block
- Tool cards
- Attachment preview
- Figma preview
- Summary ngắn của review, validation, logs

### Chuyển sang shell native

- File/context explorer
- Agent/model quick switch
- Runtime log stream đầy đủ
- Mở diff file thay đổi
- Thông báo lỗi/thành công/trạng thái
- Một phần approval flow
- Một phần quality/settings flow

## Roadmap đề xuất

### Phase 1: low-risk, tác động cao

- Thêm `OutputChannel` cho runtime logs
- Thêm `StatusBarItem` cho trạng thái run, model, approval mode
- Thêm `QuickPick` cho chọn agent/model
- Thêm native progress và notifications

Kết quả mong muốn:

- User không phải mở webview để xem mọi trạng thái nền
- Shell của VS Code bắt đầu đóng vai trò rõ ràng hơn

### Phase 2: nâng trải nghiệm làm việc với code

- Tách file/context picker sang `TreeView`
- Mở file diff bằng `vscode.diff`
- Giữ summary thay đổi trong webview nhưng đẩy phần đọc code sang editor native

Kết quả mong muốn:

- Webview nhẹ hơn
- Flow review/chỉnh sửa hợp với thói quen dùng editor của VS Code hơn

### Phase 3: hybrid controls

- Tách approval flow thành 2 mức
- Approval đơn giản: native prompt
- Approval phức tạp: giữ webview
- Đồng bộ quality toggles với settings và command palette

Kết quả mong muốn:

- Những thao tác nhanh không phải đi qua UI chat
- Những case phức tạp vẫn giữ được richness của Galaxy

## Non-goals

- Không rewrite toàn bộ sang native chat participant như Copilot
- Không bỏ webview chat chính
- Không chuyển mọi thành phần sang shell chỉ vì "native nhìn giống VS Code hơn"

Mục tiêu ở đây là dùng đúng công cụ cho đúng việc, không phải giảm webview bằng mọi giá.

## Thứ tự triển khai khuyến nghị

1. `OutputChannel`
2. `StatusBarItem`
3. `QuickPick` cho agent/model
4. Native notifications/progress
5. `TreeView` cho file/context
6. `vscode.diff` cho review file-level
7. Approval hybrid

## Đánh giá tổng thể

Kiến trúc phù hợp nhất cho `galaxy-vscode-extension` là:

- `webview` cho core chat experience
- `VS Code shell` cho surrounding workflows

Đây là hướng cân bằng nhất giữa:

- bản sắc riêng của Galaxy
- trải nghiệm native trong VS Code
- chi phí refactor hợp lý

## File liên quan trong codebase hiện tại

- `package.json`
- `src/extension.ts`
- `src/shared/protocol.ts`
- `webview/src/App.tsx`
- `webview/src/main.tsx`
