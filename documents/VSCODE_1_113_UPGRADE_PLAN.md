# VS Code 1.113 Upgrade Plan

## Mục tiêu

Tài liệu này chốt lý do, phạm vi, và thứ tự triển khai cho việc nâng `galaxy-vscode-extension` từ baseline `VS Code ^1.90.0` lên `VS Code ^1.113.0`.

Mục tiêu chính:

- Mở đường cho các API AI/chat mới hơn của VS Code
- Tạo nền để tận dụng `Chat API`, `chat participants`, và các primitive AI extensibility hiện đại hơn
- Giữ kiến trúc `webview-first` hiện tại trong ngắn hạn, không rewrite vội sang native chat
- Tách rõ phần nào của `1.113` có ích thật cho Galaxy và phần nào không giúp trực tiếp

## Trạng thái hiện tại

Trong codebase hiện tại:

- `package.json` đang khai báo `engines.vscode: ^1.90.0`
- `@types/vscode` đang là `^1.90.0`
- Chat chính của Galaxy đang chạy bằng `WebviewViewProvider` + `WebviewPanel`
- Transcript/message list là custom React UI trong webview

Điều này có nghĩa:

- nâng phiên bản VS Code không tự động cải thiện giao diện transcript hiện tại
- mọi cải thiện về message list vẫn phải sửa trực tiếp ở webview UI
- giá trị lớn nhất của upgrade là mở rộng bề mặt API cho các bước hybrid/native về sau

## Những gì VS Code 1.113 có thể giúp

### 1. Mở đường cho Chat API hiện đại hơn

VS Code hiện đã có hệ `Chat API` và `chat participants` trưởng thành hơn nhiều so với baseline `1.90`.

Lợi ích cho Galaxy:

- có thể tạo một `Galaxy participant` native cho một số workflow chọn lọc
- có thể đưa một phần capability của Galaxy vào ask mode native thay vì dồn hết vào webview
- có thể chia rõ:
  - `webview` cho branded chat UX
  - native chat cho một số tác vụ editor-centric hoặc lightweight

### 2. Mở đường cho AI extensibility mới

Hệ AI extensibility hiện nay hỗ trợ tốt hơn cho:

- domain-specific assistants
- tool orchestration
- tích hợp sâu hơn với shell/editor/chat flows của VS Code

Đây là lợi ích kiến trúc dài hạn, không phải lợi ích UI tức thời.

### 3. Khả năng hòa nhập tốt hơn với shell/native workflows

Khi baseline cao hơn, extension có thể dễ tận dụng hơn các flow native mới quanh:

- chat integration
- model/tool related commands
- attachment/image related experiences
- agent-style workflows

Tuy nhiên các trải nghiệm như:

- `Chat Customizations editor`
- `Configurable thinking effort`
- `Nested subagents`
- `Images preview`

thuộc hệ chat native của VS Code/Copilot. Chúng không tự áp dụng cho transcript webview hiện tại của Galaxy.

## Những gì upgrade KHÔNG giải quyết trực tiếp

### 1. Không làm đẹp message list hiện tại

Transcript hiện tại là custom UI.

Các file liên quan trực tiếp:

- `webview/src/components/chat/Transcript.tsx`
- `webview/src/components/chat/MessageCard.tsx`
- `webview/src/components/chat/StreamingAssistantCard.tsx`
- `webview/src/styles.css`

Nâng từ `1.90` lên `1.113` không biến các component này thành native chat UI.

### 2. Không tự mang lại UI giống Copilot Chat

VS Code không cung cấp public widget để extension webview “mượn” nguyên message list của Chat view.

Muốn có native chat UI thật, Galaxy phải đi gần hơn tới:

- `Chat API`
- `chat participants`
- native chat surface của VS Code

Đây là thay đổi kiến trúc, không phải đổi version đơn thuần.

### 3. Không tự sửa theme mismatch của Galaxy

Hiện UI đang còn hardcode màu sắc riêng, nên cảm giác tách rời khỏi VS Code shell.

Việc này phải xử lý riêng bằng:

- VS Code theme tokens
- typography tốt hơn
- giảm card chrome dư thừa

## Hướng kiến trúc khuyến nghị sau upgrade

### Ngắn hạn

- Nâng baseline lên `1.113`
- Giữ chat chính trong webview
- Cải thiện transcript/message list bằng thiết kế gần shell native hơn
- Đồng bộ màu sắc theo VS Code theme tokens

### Trung hạn

- Bổ sung một số integration dùng `Chat API`
- Cân nhắc `Galaxy participant` cho các flow phù hợp
- Giữ mô hình hybrid thay vì rewrite toàn bộ

### Dài hạn

- Đánh giá xem có nên tách:
  - branded Galaxy chat trong sidebar
  - native Galaxy participant trong Chat view

Mô hình này cho phép:

- giữ bản sắc Galaxy
- tận dụng nền tảng chat/agent mới của VS Code
- tránh ép mọi thứ vào một webview lớn

## Kế hoạch triển khai

### Phase 1: baseline upgrade

Mục tiêu:

- cập nhật version constraint và type surface
- phát hiện sớm breaking change ở compile/lint/test

Checklist:

- cập nhật `engines.vscode` lên `^1.113.0`
- cập nhật `@types/vscode` lên bản cao nhất đang tồn tại trên npm tại thời điểm upgrade
- lưu ý: `engines.vscode` có thể cao hơn `@types/vscode` nếu npm chưa phát hành types tương ứng
- rà lại API deprecated hoặc signature thay đổi
- chạy `check-types`
- chạy `lint`
- chạy test nếu môi trường cho phép

### Phase 2: UI debt cleanup cho transcript

Mục tiêu:

- cải thiện phần đang “xấu” mà upgrade version không tự sửa

Checklist:

- giảm độ nặng của message card
- dùng theme tokens của VS Code thay cho palette hardcode
- cải thiện typography cho assistant response
- phân cấp visual rõ hơn giữa:
  - user message
  - assistant message
  - tool/thinking blocks
- giảm header chrome dư thừa trong message list

### Phase 3: selective native integration

Mục tiêu:

- tận dụng `1.113` đúng chỗ mà không rewrite quá lớn

Ứng viên:

- thử nghiệm `Galaxy` chat participant native
- đẩy một số lightweight workflows sang native chat
- giữ transcript phong cách Galaxy cho use case cần branded UX

## Rủi ro

### 1. Type/API drift

Khi nâng `@types/vscode`, có thể xuất hiện lỗi compile do API typing chặt hơn hoặc đã đổi shape.

### 2. Runtime compatibility

Nếu code vô tình bắt đầu dựa vào API mới mà không guard đúng, extension có thể không chạy trên các bản VS Code cũ hơn.

### 3. Scope creep

Nâng version dễ bị kéo sang một đợt rewrite chat UI. Điều này không nên xảy ra ở phase đầu.

## Nguyên tắc triển khai

- Không gộp `upgrade baseline` với `rewrite transcript`
- Không giả định rằng feature của Copilot Chat đồng nghĩa với public API cho mọi extension
- Chỉ tận dụng `1.113` ở nơi mang lại giá trị thật cho Galaxy
- Giữ hướng `hybrid`: branded webview cho core UX, native shell cho surrounding workflows

## Quyết định hiện tại

Quyết định đề xuất:

1. Tiến hành nâng baseline từ `1.90.0` lên `1.113.0`
2. Sau khi baseline ổn định, ưu tiên sửa transcript/message list
3. Chỉ sau đó mới đánh giá tích hợp thêm `Chat API` hoặc `Galaxy participant`

## File liên quan trực tiếp

- `package.json`
- `src/extension.ts`
- `webview/src/components/chat/Transcript.tsx`
- `webview/src/components/chat/MessageCard.tsx`
- `webview/src/components/chat/StreamingAssistantCard.tsx`
- `webview/src/styles.css`
