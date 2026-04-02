# Extension Runtime Issues And Fix Plan

## Muc tieu

Tai lieu nay tong hop cac van de runtime da xac nhan qua `debug.log`, `ui-transcript.jsonl`, va code hien tai cua `galaxy-vscode-extension`, sau do xep thu tu fix de giam:

- transcript nhieu message noi bo
- review/validation bi ep khi khong can
- vong lap read/edit/read va repair loop
- cam giac agent "tu noi voi chinh no" thay vi phuc vu user

## Van de 1: Internal control messages dang hien thi nhu message cua user

### Hien tuong

UI dang hien cac message nhu:

- `Background command completed...`
- `[SYSTEM CODE REVIEW FEEDBACK] ...`
- `[SYSTEM VALIDATION FEEDBACK] ...`

voi role `user`, du nguoi dung khong he nhap cac noi dung nay.

### Bang chung

- `background-complete-*` duoc persist vao `ui-transcript.jsonl` voi `role: "user"`.
- `review-repair-*` duoc persist vao `ui-transcript.jsonl` voi `role: "user"`.
- `validation-repair-*` duoc tao tu quality gate voi `role: "user"`.

### Nguyen nhan goc

Runtime hien tai dung `ChatMessage` role `user` lam co che truyen control prompt noi bo vao model cho:

- background terminal completion follow-up
- review auto-repair
- validation auto-repair
- empty auto-continue

### Tac dong

- transcript bi "ban"
- nguoi dung nham tuong do la input cua minh
- history memory va task memory co the bi lech ngu canh
- model co the hoc nham rang nhung message noi bo nay la mot phan hoi thoai binh thuong

### Cach fix

1. Khong persist control prompts noi bo vao UI transcript nhu `role: "user"`.
2. Tach mot loai message noi bo rieng, vi du:
   - `internal`
   - hoac `system-runtime`
3. Chi dua message noi bo vao history/model input, nhung khong mirror sang webview transcript.
4. Neu can hien cho debug, dua vao runtime logs hoac mot panel diagnostics rieng, khong dua vao luong hoi thoai user.

### Uu tien

Cao.

## Van de 2: Review/validation dang ep chay cho moi file change, ke ca markdown/doc-only

### Hien tuong

Chi can agent ghi file la quality gate co the chay review va validation, ke ca khi file vua sua la `.md`.

### Nguyen nhan goc

Logic gate hien tai dua vao:

- `filesWritten.length > 0`
- `reviewEnabled || validateEnabled`

ma khong phan loai:

- source code
- config
- docs/markdown
- generated files

Reviewer hien tai cung doc moi `sessionFiles` vua thay doi ma khong loc bo `.md`.

### Tac dong

- sua tai lieu van bi code review
- co them review findings sai ngu canh
- sinh auto-repair loop khong can thiet
- tang reread va lam transcript nhieu noise

### Cach fix

1. Them bo loc `sessionFiles` theo file category:
   - `code`
   - `config`
   - `docs`
   - `generated`
2. Review chi chay cho:
   - `code`
   - va co the mot phan `config` khi can
3. Validation cuoi turn chi chay:
   - command-level validation neu co code/config impact
   - bo qua review cho `doc-only changes`
4. Neu turn chi sua docs:
   - skip review
   - skip project validation nặng
   - chi giu `validate_code(path)` neu user goi ro rang

### Uu tien

Cao.

## Van de 3: Background command completion dang tu dong sinh repair turn nhu mot turn moi

### Hien tuong

Sau khi terminal/background command xong, host tu tao message:

- `Background command completed...`

roi lai tu dong chay `runInternalRepairTurn(...)`.

### Nguyen nhan goc

Background completion queue hien dang duoc noi truc tiep vao repair flow.

Thay vi:

- cap nhat state
- cho agent quyet dinh o turn tiep theo

host lai:

- tao user-like control prompt
- kich hoat mot repair turn moi ngay lap tuc

### Tac dong

- command xong la agent lai tu "noi tiep"
- vong loop co the tiep tuc du user da duoc tra loi gan xong
- de sinh reread, re-edit, rerun command

### Cach fix

1. Tach background completion thanh event noi bo, khong auto tao user transcript message.
2. Mac dinh:
   - chi update `context.json`
   - chi append runtime log
   - chi danh dau background completion available
3. Chi cho phep auto-follow-up khi command do duoc danh dau ro rang la:
   - `requiresFollowup`
   - hoac `blockingForCurrentTurn`
4. Neu command fail:
   - khong rerun sua loi tu dong vo han
   - dua failure vao quality/runtime detail de agent quyet dinh trong mot turn co kiem soat

### Uu tien

Cao.

## Van de 4: Read/edit/read loop van cao khi sua document markdown

### Hien tuong

Agent co the:

- `read_file`
- `multi_edit_file_ranges`
- `read_file`
- `edit_file_range`
- `grep`

lap lai nhieu lan tren cung mot file `.md`.

### Nguyen nhan goc

Day khong phai loi cua workflow graph retrieval.

Workflow Graph Trace RAG hien tai toi uu cho:

- hieu luong he thong
- graph path
- flow retrieval
- code understanding

No khong toi uu truc tiep cho:

- exact line-based markdown editing
- stale line snapshots sau moi edit

Line-edit safety hien tai co chu y tot:

- sau moi edit, snapshot cu de stale
- agent phai reread de lay state moi

Van de nang hon la loop nay dang bi nhan len boi:

- review auto-repair
- validation auto-repair
- background completion repair

### Cach fix

1. Giam quality gate cho doc-only changes truoc.
2. Them heuristic cho document editing:
   - neu dang sua 1 file markdown duy nhat
   - uu tien gom patch theo plan lon hon
   - han che alternating `read -> single edit -> read`
3. Them `document edit plan memory` cho current turn:
   - da doc doan nao
   - da edit doan nao
   - sau edit co the cap nhat local shadow text thay vi reread toan bo ngay
4. Chi reread file khi:
   - snapshot da stale that su
   - tool tra conflict
   - hoac can xac minh exact final output

### Uu tien

Trung binh cao.

## Van de 5: Workflow Graph RAG da co nhung chua phu hop cho doc-edit loop

### Hien tuong

Ky vong la da co RAG/graph thi phai doc lai it hon. Dieu nay dung cho flow questions, nhung chua dung cho markdown editing.

### Nguyen nhan goc

Reread guard hien tai duoc bat cho:

- flow query
- workflow evidence du manh

No khong duoc bat cho:

- exact file editing tasks
- markdown/document rewrite

### Cach fix

1. Giu nguyen workflow graph cho use case flow understanding.
2. Khong "ep" workflow graph giai bai toan markdown edit.
3. Neu muon giam reread cho docs, can mot lop rieng:
   - document edit memory
   - doc patch planner
   - stale snapshot minimization

### Uu tien

Trung binh.

## Thu tu fix de xuat

### Phase 1: Giam noise va loop nặng

1. Internal control prompts khong duoc hien nhu user transcript.
2. Skip review/validation nặng cho doc-only changes.
3. Background command completion khong auto mo repair turn mac dinh.

### Phase 2: Giam reread trong doc editing

4. Them document-edit heuristics cho markdown.
5. Giam stale review finding impact o orchestration layer, khong chi o prompt.

### Phase 3: Lam ro command lifecycle va giu planner bam sat task

6. Tach ro `command started/background running` va `command completed successfully`.
7. Manual planning/read-plan phai scope theo file/task hien tai, khong goi y file lac de sau failure.

## Van de 6: Terminal command semantics de gay hieu nham la "da thanh cong"

### Hien tuong

Trong log co the thay:

- tool message bao `success=true`
- nhung command thuc te lai fail o terminal/background sau do

Dieu nay lam agent va nguoi dung de hieu nham rang command da "lam xong", trong khi y nghia dung hon la:

- da bat dau thanh cong
- da handoff vao background
- dang cho ket qua cuoi

### Nguyen nhan goc

`run_terminal_command` va mot phan `run_project_command` dung contract async:

- start thanh cong -> `ToolResult.success = true`
- ket qua cuoi cung se den qua command lifecycle event sau

Van de nam o transcript/debug messaging:

- content chua du nhan manh trang thai `running/background`
- debug log van hien `success=true` ma khong kem `state=running`

### Tac dong

- de suy luan sai ve command state
- de sinh repair turn som hoac stale context
- nguoi dung nhin transcript se thay "success" du command chua xong

### Cach fix

1. Giu async-start contract, khong bien no thanh failed state gia tao.
2. Them `commandState`/state metadata ro rang:
   - `running`
   - `completed`
   - `failed`
3. Tool message va debug log phai uu tien hien state:
   - `started`
   - `background running`
   - `completed`
4. Chi coi command "thanh cong that su" khi co completion event/exit code ro rang.

### Uu tien

Cao.

## Van de 7: Manual read plan co the goi y file lac de sau command failure

### Hien tuong

Sau khi mot command fail trong mot task cuc bo, manual planning van co the dua ra read plan voi file khong lien quan truc tiep toi file dang sua.

Vi du:

- dang sua file markdown cua extension
- nhung hint lai nhac toi file thuoc `galaxy-code` hoac module khong lien quan

### Nguyen nhan goc

Prompt builder va syntax candidate selection hien tai van ket hop:

- mentioned paths
- working turn files
- retrieval seed rong
- syntax candidates toan cuc

ma chua co lop scope du manh cho:

- exact current file
- current task family
- current failure locus

### Tac dong

- model bi keo lech huong sau failure
- tang reread khong can thiet
- doc sai file khi dang can tap trung vao mot file/task cuc bo

### Cach fix

1. Neu task co path scope manh:
   - file duoc user nhac ro
   - file vua doc/sua trong working turn
   - file vua fail command lien quan
   thi manual planning phai uu tien scope do.
2. Chi cho phep candidate ngoai scope khi:
   - khong co candidate trong scope
   - hoac task ro rang la cross-file/system flow
3. Manual read batches phai duoc tao tu tap da scope, khong lay thang candidate rong.

### Uu tien

Cao.

## Definition of Done bo sung

- Internal control prompts khong xuat hien nhu `user` transcript message.
- Doc-only changes khong bi ep review/validation nặng.
- Background command completion khong auto mo mot repair turn moi.
- Tool/runtime logs phan biet ro:
  - command started
  - background running
  - command completed
- Manual planning cho task file-cuc-bo khong goi y file lac de ngoai scope task.

## Trang thai hien tai

### Da fix

- Internal repair prompts khong con bi mirror vao user transcript mac dinh.
- Doc-only session files da skip blocking review/validation.
- Background command completion da chi record context, khong auto mo repair turn.
- Tool metadata cho terminal/project command da co `commandState` va `running`.
- Transcript/debug log da hien ro state `running` cho command background.
- Manual planning/read-plan da duoc scope theo path task hien tai khi co file scope manh.

### Da co regression test

- Internal repair turn khong mirror control prompt vao transcript.
- Background command tool duoc danh dau `background running` thay vi hien nhu da complete.
- Debug log ghi ro `state=running` cho tool message.
- Manual planning scope giu candidate trong file task hien tai.

### Con ton du

- Van con warning `DEP0169 url.parse()` tu dependency/runtime ngoai pham vi patch nay.
- Trong `vscode-test` van co warning shell environment resolve timeout cua VS Code host, nhung test suite van pass.
- Van con mot warning `The 'path' argument is deprecated...` xuat hien trong mot test workflow retrieval; can truy vet them callsite con sot neu muon lam sach hoan toan.
5. Them current-turn document edit memory/shadow text.

### Phase 3: Do luong va xac nhan

6. Them telemetry rieng cho:
   - internal control prompts hidden
   - doc-only quality gate skips
   - background completion follow-up count
   - reread reduction tren 1 file duy nhat
7. Viet regression tests cho:
   - no synthetic user transcript leak
   - doc-only change skip review
   - background completion khong auto-loop

## Definition of Done cho dot fix nay

- Transcript khong con hien `[SYSTEM CODE REVIEW FEEDBACK]` va `Background command completed...` nhu message cua user.
- Turn chi sua `.md` khong bi code review tu dong.
- Background command xong khong tu dong mo repair turn neu khong that su can.
- So lan `read_file` lap lai tren 1 file markdown giam ro ret trong debug log.
- Khong lam vo regression cua quality gate cho code changes thuc su.
