# Galaxy Code

Galaxy Code là một extension chat chạy trong thanh sidebar của VS Code cho hệ sinh thái Galaxy. Đây là phiên bản VS Code của `galaxy-code`: một AI coding agent có hiểu biết workspace, hỗ trợ file tools, đọc tài liệu, validation, review, approvals, attachments, và memory theo project.

## Xây dựng trên Galaxy Design

Extension này được xây dựng bằng [Galaxy Design](https://github.com/buikevin/galaxy-design) - một thư viện component universal cung cấp các UI component đẹp, accessible cho Vue, React, Angular, React Native, và Flutter.

### Tính năng của Galaxy Design

- **Hỗ trợ đa nền tảng**: Xây dựng với Vue 3, React, Angular, React Native, hoặc Flutter
- **Accessible mặc định**: Dựa trên Radix primitives với ARIA support, keyboard navigation, và focus management
- **Dễ tùy chỉnh**: Styled với Tailwind CSS, dễ dàng customize và mở rộng
- **Copy-Paste Components**: Sở hữu code của bạn không cần npm dependencies
- **Dark Mode**: Hỗ trợ dark mode đầy đủ với dễ dàng tùy chỉnh theme
- **i18n Ready**: Tài liệu song ngữ (Anh/Việt) và hỗ trợ quốc tế hóa
- **CLI Tooling**: Hỗ trợ CLI đầy đủ để khởi tạo và quản lý component qua `npx galaxy-design@latest`

### Bắt đầu với Galaxy Design

```bash
# Khởi tạo Galaxy Design trong project của bạn
npx galaxy-design@latest init

# Thêm các components
npx galaxy-design@latest add button input dialog
```

Để biết thêm thông tin, truy cập [Galaxy Design trên GitHub](https://github.com/buikevin/galaxy-design).

## Phạm vi hiện tại

Extension hiện hỗ trợ:

- sidebar `Galaxy Code` riêng trong activity bar của VS Code
- chat streaming với `manual`, `ollama`, `gemini`, `claude`, và `codex`
- file tools và document tools cho workspace
- chạy command trong project có kiểm soát quyền
- luồng validation và review
- attachments local và tích hợp Figma bridge
- memory ngắn hạn và dài hạn được lưu theo từng workspace

## Commands

- `Galaxy Code: Clear Chat History`
- `Galaxy Code: Open Config Folder`

Phím tắt mặc định:

- `Cmd+Shift+G` trên macOS
- `Ctrl+Shift+G` trên Windows/Linux

## Bề mặt tool của AI Agent

AI Agent hiện tại có thể dùng các nhóm tool sau.

### Đọc dữ liệu

- `read_file(path, maxLines?, offset?)`
- `read_document(path)`
- `grep(pattern, path, contextLines?)`
- `list_dir(path)`
- `head(path, lines?)`
- `tail(path, lines?)`
- `search_web(query, maxResults?, searchDepth?, includeAnswer?, includeRawContent?, includeDomains?, excludeDomains?, timeRange?)`
- `extract_web(urls, extractDepth?, format?, query?, includeImages?, maxCharsPerUrl?)`

### Ghi và chỉnh sửa

- `edit_file(path, old_string, new_string, replace_all?)`
- `write_file(path, content)`

### Action trong project

- `run_project_command(command, cwd?, maxChars?)`

Đây là action tool chính để chạy build, test, lint, git, setup, hoặc các command khác trong workspace. Việc thực thi phụ thuộc vào quyền của project hiện tại.

### Thiết kế Semantic Command Tools

Hiện đã có tài liệu thiết kế cho nhóm tool semantic trong tương lai như:

- `run_lint(path?)`
- `run_static_check(path?)`
- `run_test(path?)`
- `run_build(path?)`

Ý chính là AI Agent chỉ nên nói ý định, còn host/runtime sẽ resolve câu lệnh thật từ bằng chứng trong project thay vì để model tự đoán shell command.

Policy thực thi dự kiến là:

- `run_lint` + `run_static_check`: ưu tiên chạy song song khi có thể
- `run_test` + `run_build`: mặc định chạy tuần tự
- khi bật quality cho validation/test:
  - chạy `request_code_review()` trước nếu review được bật
  - sau đó chạy `run_lint()` + `run_static_check()` nếu resolve được
  - rồi mới chạy `run_test()` khi cần
  - giữ `validate_code(path)` như lớp safety net cuối cho từng file, không phải bước bắt buộc luôn luôn chạy

Xem thêm:

- [documents/SEMANTIC_PROJECT_COMMAND_TOOLS.md](/Users/buitronghieu/Desktop/Project/galaxy/galaxy-vscode-extension/documents/SEMANTIC_PROJECT_COMMAND_TOOLS.md)
- [documents/BASE_COMPONENT_PROFILE.md](/Users/buitronghieu/Desktop/Project/galaxy/galaxy-vscode-extension/documents/BASE_COMPONENT_PROFILE.md)

### Tool chất lượng

Chỉ xuất hiện khi được bật trong config hoặc trong composer:

- `validate_code(path)`
- `request_code_review()`

### Tool Galaxy Design

Hiện tại vẫn đang là tool riêng:

- `galaxy_design_project_info(path?)`
- `galaxy_design_registry(framework?, component?, group?, query?, path?)`
- `galaxy_design_init(path?)`
- `galaxy_design_add(components, path?)`

## Kiến trúc session và memory

Galaxy Code trong VS Code hiện dùng 4 lớp memory khác nhau.

### 1. UI Transcript

Mục đích:

- khôi phục giao diện chat
- giữ lịch sử hội thoại hiển thị cho user
- không dùng làm nguồn prompt raw chính

Nơi lưu:

- `~/.galaxy/projects/<workspace>/ui-transcript.jsonl`

### 2. Working Session

Mục đích:

- giữ context raw ngắn hạn cho yêu cầu hiện tại của user
- chứa user message, context note, assistant draft, thinking, context messages, và tool digests

Hành vi:

- được tạo khi bắt đầu một yêu cầu mới
- bị xóa khi yêu cầu kết thúc
- nếu token tăng quá lớn thì session này sẽ rollover thay vì tiếp tục phình ra vô hạn

Ghi chú:

- trong code hiện tại vẫn dùng tên nội bộ `workingTurn`, nhưng hành vi đã được chỉnh theo đúng nghĩa `workingSession`

### 3. Active Task Memory

Mục đích:

- giữ trạng thái của task hiện tại xuyên qua nhiều lần rollover
- đảm bảo AI Agent không quên user đang yêu cầu gì và đã làm đến đâu

Nội dung:

- mục tiêu gốc của user
- objective hiện tại
- definition of done
- các bước đã hoàn thành
- các bước còn pending
- blockers
- files đã đụng tới
- key files
- attachments
- denied commands
- recent handoff summaries
- latest handoff summary

Nơi lưu:

- `~/.galaxy/projects/<workspace>/session-memory.json`

### 4. Project Memory

Mục đích:

- giữ tri nhớ dài hạn của workspace
- lưu các thông tin vượt ra ngoài một request cụ thể

Nội dung:

- project summary
- conventions
- recurring pitfalls
- recent decisions
- key files

Nơi lưu:

- `~/.galaxy/projects/<workspace>/session-memory.json`

### Sơ đồ dễ nhớ

```text
UI Transcript
= thứ user nhìn thấy lại trong UI

Working Session
= não ngắn hạn cho request đang chạy ngay lúc này

Active Task Memory
= trạng thái task hiện tại phải giữ qua nhiều lần rollover

Project Memory
= tri nhớ dài hạn của workspace

Tool Evidence
= biên lai/tool receipts riêng, được chọn lọc để bơm vào prompt khi liên quan
```

### Workflow của một request

```text
User gửi message
  -> tạo Working Session mới
  -> nếu message != "continued" thì reset Active Task Memory cho task mới
  -> build prompt từ:
       notes
       + project memory
       + active task memory
       + relevant tool evidence
       + context note / compact summary
       + user message hiện tại
       + tool/context messages của working session
  -> agent suy nghĩ + gọi tool
  -> tool digest được thêm vào working session
  -> tool evidence được lưu riêng nếu cần
  -> nếu working session quá lớn thì rollover
  -> khi trả lời xong:
       merge working session vào active task memory
       merge handoff/decision/files quan trọng vào project memory
       lưu session-memory.json
       xóa working session
```

## Cơ chế rollover của working session

Khi working session trở nên quá lớn:

1. Galaxy Code tạo `handoff summary`
2. handoff này được merge vào `activeTaskMemory`
3. files và decision quan trọng được merge vào `projectMemory`
4. một working session mới được tạo cho cùng yêu cầu hiện tại
5. prompt tiếp theo sẽ dùng:
   - project memory
   - active task memory
   - tool evidence
   - working session mới

Cơ chế này giúp tránh mất trí nhớ khi một yêu cầu quá lớn để hoàn thành trong một raw prompt window.

### Workflow rollover dễ nhớ

```text
Working Session quá lớn
  -> tạo handoff summary
  -> merge summary + completed steps + blockers + files touched vào Active Task Memory
  -> merge summary + recent decisions + key files vào Project Memory
  -> lưu session memory xuống disk
  -> tạo Working Session mới cho cùng request:
       giữ nguyên user message
       giữ context note nếu có
       reset assistant draft
       reset raw context messages
       reset tool digests
       gắn compact summary để prompt sau biết vừa xảy ra gì
```

### Mẹo ghi nhớ nhanh

- `UI Transcript` để khôi phục giao diện, không phải prompt raw chính.
- `Working Session` là cái đang diễn ra bây giờ; xong request là biến mất.
- `Active Task Memory` giữ cho task không bị quên khi rollover.
- `Project Memory` giữ tri nhớ dài hơi của workspace.
- `Tool Evidence` không phải memory layer chính, nhưng là nguồn bằng chứng được chọn lọc để nhét vào prompt tiếp theo.

## Luồng Hybrid RAG Hiện Tại

Galaxy Code hiện không dùng một kiểu retrieval duy nhất. Nó dùng `hybrid RAG`, tức là trộn nhiều nguồn tín hiệu để tìm đúng context trước khi model trả lời hoặc gọi tool.

### Mục tiêu

Luồng này giúp AI Agent:

- tìm đúng file, đúng symbol, đúng tài liệu nhanh hơn
- giảm đọc file lung tung
- giảm reread không cần thiết
- nhớ tốt hơn những gì đã đọc hoặc vừa sửa
- quay lại đúng vùng code/doc đã liên quan ở các turn sau

### Các lớp retrieval chính

#### 1. Syntax / Symbol Retrieval

Lớp này dùng:

- file path
- basename
- path segment
- export/import graph
- definition/reference candidates
- symbol candidates

Nó mạnh khi user nhắc khá rõ về:

- tên file
- tên class
- tên function
- component
- module

Ví dụ:

- "sửa `UserService`"
- "xem `vite.config.ts`"
- "nút `Button` nằm ở đâu"

#### 2. Lexical Retrieval

Lớp này match theo text gần đúng:

- token trong query
- token trong path
- token trong symbol
- token trong semantic chunk title

Nó hữu ích khi query có từ khóa đúng hoặc gần đúng nhưng không đủ mạnh để chỉ ra chính xác một symbol.

#### 3. Semantic Retrieval Với Gemini Embeddings

Lớp này dùng `Google Gemini embeddings` để so ngữ nghĩa.

Cụ thể:

- query của user được embed bằng `gemini-embedding-001`
- các semantic chunks của code/doc cũng có embedding
- hệ so similarity giữa query và chunk

Nhờ đó, agent có thể tìm đúng ngữ cảnh ngay cả khi user không dùng đúng tên file hay tên symbol.

Ví dụ:

- user hỏi: `phần thẩm định hồ sơ doanh nghiệp realtime nằm đâu`
- code thật lại có tên function khác hẳn như `evaluateBusinessRealtimeCreditProfile`

Nếu chỉ match theo chữ thì có thể trượt.
Nếu có embeddings thì hệ vẫn có thể kéo đúng file/chunk lên top candidate vì chúng gần nhau về nghĩa.

#### 4. Tool Evidence Retrieval

Lớp này nhớ những gì agent đã làm:

- đã đọc file nào
- đã grep gì
- đã sửa file nào
- command nào vừa chạy
- evidence nào còn fresh
- evidence nào cần refresh

Nhờ đó, turn sau không phải đọc lại từ đầu một cách mù quáng.

#### 5. SQLite Metadata + Read Cache

Galaxy hiện dùng `rag-metadata.sqlite` để lưu:

- syntax metadata
- symbol metadata
- semantic chunk metadata
- tool evidence metadata
- read cache cho `read_file`
- read cache cho `read_document`

Read cache hoạt động theo nguyên tắc:

- key theo:
  - `filePath`
  - `mtime`
  - `size`
  - `readMode`
  - `offset`
  - `limit`
- nếu file chưa đổi thì dùng lại nội dung từ SQLite
- nếu file đã đổi thì đọc lại file thật và ghi cache mới

Điều này đặc biệt hữu ích với:

- `.docx`
- `.pdf`
- file lớn
- các file bị đọc lặp nhiều lần theo chunk

### Luồng xử lý từng bước

Khi user gửi yêu cầu, hệ đi theo flow gần như sau:

```text
User gửi yêu cầu
  -> parse query
  -> lấy syntax/symbol candidates
  -> lấy lexical candidates
  -> lấy semantic candidates bằng Gemini embeddings
  -> lấy evidence gần đây và trạng thái freshness
  -> lấy SQLite hint paths + read cache metadata
  -> rerank tất cả candidate theo hybrid score
  -> build prompt context:
       project memory
       active task memory
       tool evidence
       hybrid retrieval block
       semantic retrieval block
       manual planning hints
       anti-loop guardrails
  -> AI Agent chọn tool phù hợp
  -> kết quả tool được ghi vào evidence + SQLite metadata
  -> turn sau reuse lại context này nếu còn phù hợp
```

### Hybrid Score Thực Tế Đến Từ Đâu

Khi rerank candidate, hệ không chỉ nhìn một tín hiệu. Nó trộn:

- path match
- basename match
- symbol hit
- definition/reference graph
- lexical similarity
- semantic similarity
- recent evidence
- freshness
- file vừa đụng gần đây
- cache/read history trong SQLite

Vì vậy cùng một query, hệ có thể ưu tiên:

- file định nghĩa
- file đang bị ảnh hưởng downstream
- chunk doc gần nghĩa nhất
- hoặc file vừa được đọc/sửa và còn relevant

### Hybrid RAG Giúp "Nhớ" Điều Gì

Hiện tại nó giúp agent nhớ tốt hơn ở các mặt sau:

- nhớ file nào đã liên quan
- nhớ symbol nào đang là focus
- nhớ chunk tài liệu nào đã đọc
- nhớ vùng nội dung nào có thể reuse từ read cache
- nhớ evidence nào còn dùng được

Nhưng cần lưu ý:

- nó không phải trí nhớ dài hạn hoàn hảo kiểu con người
- nó mạnh ở retrieval và continuity thực dụng
- còn memory quyết định dài hạn của task vẫn chủ yếu là heuristic + session memory

### Khi Nào Hybrid RAG Tỏ Ra Hữu Ích Nhất

- workspace lớn nhiều file
- user mô tả tính năng bằng ngôn ngữ tự nhiên
- phải đọc tài liệu dài hoặc file `.docx/.pdf`
- cần quay lại cùng một vùng code/doc qua nhiều turn
- cần giảm loop đọc đi đọc lại

## Chiến lược token

Prompt usage hiện không còn được hiểu đơn giản là "chỉ raw chat messages mới nhất".

Extension hiện tính đến:

- system prompt
- tool schema
- project memory
- active task memory
- tool evidence
- working session context

Nhờ đó phần trăm token sẽ phản ánh tổng budget thực tế thay vì chỉ một turn raw ngắn hạn.

## Attachments

Attachments được copy vào chính workspace để user chủ động xem và xóa khi cần.

Nơi lưu:

- `<workspace>/.galaxy/attachments/files`
- `<workspace>/.galaxy/attachments/images`
- `<workspace>/.galaxy/attachments/figma`
- `<workspace>/.galaxy/setting.local.json`

Hành vi:

- file local và ảnh local được copy vào `workspace/.galaxy/attachments`
- attachment từ Figma cũng được lưu tại đây
- attachment dạng draft có thể xóa trước khi gửi
- attachment đã commit sẽ được lưu cùng transcript message

## Config và project storage

### Global config

Nơi lưu:

- `~/.galaxy/config.json`

Đây vẫn là config global cho provider và các default chung.

### Runtime storage theo workspace

Nơi lưu:

- `~/.galaxy/projects/<workspace>`

Bao gồm:

- `debug.log`
- `session-memory.json`
- `ui-transcript.jsonl`
- `tool-evidence.jsonl`
- `figma-imports.jsonl`
- các file runtime/session khác

### Local settings theo workspace

Nơi lưu:

- `<workspace>/.galaxy/setting.local.json`

Định dạng hiện tại:

```json
{
  "permissions": {
    "allow": [],
    "deny": [],
    "ask": []
  }
}
```

File này được dùng cho quyền chạy command trong chính project hiện tại.

## Approval model

`run_project_command(...)` sẽ được kiểm tra với file quyền của workspace.

Nếu command chưa có rule:

- `allow` sẽ cho chạy và lưu vào `permissions.allow`
- `deny` sẽ chặn và lưu vào `permissions.deny`
- `ask` sẽ lưu vào `permissions.ask` để lần sau vẫn hỏi lại

Các command bị từ chối cũng được phản hồi lại cho AI Agent để nó không retry mù.

## Validation và review

Validation và review đang chạy theo config:

- `validate_code(path)` là fallback nhẹ cho từng file
- final validation chạy như một phase cuối khi validation được bật
- quality flow dự kiến là:
  - `request_code_review()` chạy trước nếu review được bật
  - `run_lint()` + `run_static_check()` chạy sau review khi có thể
  - `run_test()` chạy sau đó nếu cần
  - `validate_code(path)` chỉ là lớp safety net cuối cho changed files hoặc khi static check mức project chưa đủ
- `request_code_review()` là tool để gọi sub-agent review trước khi chạy test nếu review được bật

## Figma Bridge

Extension có local Figma bridge:

- nhận dữ liệu từ Figma plugin qua local bridge
- lưu metadata import theo workspace
- cho phép attach Figma design trong composer

Payload Figma không được bơm thành tool công khai cho model, mà đi qua luồng attach trong UI.

## Phát triển

```bash
yarn install
yarn run check-types
yarn run lint
yarn run watch
```

Sau đó bấm `F5` trong VS Code để mở `Extension Development Host`.

## Trạng thái hiện tại

Đây không còn là một shell UI đơn giản nữa. Extension hiện đã có:

- provider runtime
- tool loop
- approval flow
- attachment storage
- Figma bridge
- validation và review
- tool evidence
- working-session memory và long-term memory có cấu trúc

Phần còn lại chủ yếu là tinh chỉnh UX, dọn kiến trúc, và đưa cùng mô hình memory này sang `galaxy-code` để đồng bộ hoàn toàn.
