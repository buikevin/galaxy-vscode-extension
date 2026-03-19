# Session And Token Architecture Plan

## Muc tieu

Quy hoach lai co che nho va token cho:

- `galaxy-code`
- `galaxy-vscode-extension`

de giai quyet 3 bai toan:

- tiet kiem token, tranh lang phi raw history
- khi phai rollover session van khong mat muc tieu dang lam
- giu duoc tri nho dai han theo project ma khong phinh prompt vo han

## Ket luan kien truc toi uu

Mo hinh "2 session" la dung huong, nhung chua du neu `session 2` chi la mot doan summary dai.

Kien truc toi uu nen tach thanh 4 lop:

1. `uiTranscript`
- Chi de hien thi va resume UI.
- Khong phai prompt context chinh.

2. `workingSession`
- Bo nho raw ngan han cua yeu cau dang chay.
- Chua user message hien tai, assistant draft, thinking, tool calls, tool results, context note.
- Day la thu se rollover khi sap het token.

3. `activeTaskMemory`
- Bo nho co cau truc cho chinh task dang mo.
- Chua:
  - `originalUserGoal`
  - `currentObjective`
  - `definitionOfDone`
  - `completedSteps`
  - `pendingSteps`
  - `blockers`
  - `filesTouched`
  - `keyFiles`
  - `attachments`
  - `deniedCommands`
  - `handoffSummary`
  - `recentTurnSummaries`
- Lop nay song xuyen nhieu `workingSession`.

4. `projectMemory`
- Bo nho dai han cua workspace.
- Chua:
  - `summary`
  - `conventions`
  - `recurringPitfalls`
  - `recentDecisions`
  - `keyFiles`

## Mapping vao he thong hien tai

### Hien tai da co

- `uiTranscript` da ton tai
- `workingTurn` dang dong vai tro gan nhat voi `workingSession`
- `sessionMemory` dang dong vai tro gan nhat voi bo nho dai han

### Hien tai con thieu

- chua tach rieng `activeTaskMemory` va `projectMemory`
- `workingTurn` bi compact trong cung object, chua rollover thanh mot working session moi dung nghia
- `% token` chua duoc ly giai theo tung lop nho

## Muc tieu implement cho `galaxy-vscode-extension`

### Lop 1: UI transcript

Van giu nguyen:

- `~/.galaxy/projects/<workspace>/ui-transcript.jsonl`

Vai tro:

- resume lich su chat
- khong dung lam prompt raw cho model

### Lop 2: Working session

Giua nguyen ten code hien tai la `workingTurn` de giam refactor rong, nhung ve nghia se duoc coi la `workingSession`.

Nguyen tac moi:

- bat dau user request moi -> tao `workingSession`
- trong luc tool loop dang chay -> raw messages nam trong `workingSession`
- neu `workingSession` sap day budget -> tao `handoff`
- merge `handoff` vao `activeTaskMemory`
- reset raw `workingSession` thanh mot session moi, van giu cung muc tieu user hien tai

### Lop 3: Active task memory

Luu trong `session-memory.json`.

Nguyen tac:

- duoc cap nhat moi khi:
  - `workingSession` rollover
  - `workingSession` finalize
  - co `recordExternalEvent`
- uu tien giu thong tin de AI Agent tiep tuc task:
  - user dang can gi
  - da lam xong gi
  - chua xong gi
  - file nao quan trong
  - dang bi chan boi gi

### Lop 4: Project memory

Luu trong `session-memory.json`.

Nguyen tac:

- chua tri nho dai han cua project
- khong append raw turn vo han
- neu qua nguong thi rewrite summary ngan hon

## Nguong token de xuat

Su dung `256k` lam hard cap, nhung khong de `workingSession` choi den tan tran.

Nguong de xuat:

- `MAX_TOKENS = 256_000`
- `WORKING_SESSION_SOFT_LIMIT = 160_000`
- `WORKING_SESSION_HARD_LIMIT = 192_000`
- `ACTIVE_TASK_MEMORY_SOFT_LIMIT = 32_000`
- `PROJECT_MEMORY_SOFT_LIMIT = 24_000`
- `RESPONSE_RESERVE = 24_000`

## Cach tinh token toi uu

Khong nen lay `% token = session1 / 256k` mot cach truc tiep.

Nen tach:

1. `fixedOverheadTokens`
- system prompt
- tool schema

2. `projectMemoryTokens`

3. `activeTaskMemoryTokens`

4. `evidenceTokens`

5. `workingSessionTokens`

6. `totalContextTokens`
- tong cua tat ca phan model that su phai mang

Cong thuc:

- `availableWorkingBudget = MAX_TOKENS - fixedOverheadTokens - projectMemoryTokens - activeTaskMemoryTokens - evidenceTokens - RESPONSE_RESERVE`
- `workingSessionUsage = workingSessionTokens / max(availableWorkingBudget, 1)`
- `totalContextUsage = totalContextTokens / MAX_TOKENS`

## Hanh vi rollover

Khi `workingSession` dat soft limit:

1. tao `handoffSummary`
2. merge vao `activeTaskMemory`
3. dua files/tool digests quan trong vao memory co cau truc
4. reset raw `workingSession`
5. tiep tuc tool loop trong mot working session moi

AI Agent o working session moi phai nhin thay:

- `originalUserGoal`
- `currentObjective`
- `definitionOfDone`
- `completedSteps`
- `pendingSteps`
- `blockers`
- `filesTouched`
- `keyFiles`
- `attachments`
- `deniedCommands`
- `what to do next`

## Hanh vi compact cho session dai han

Neu `activeTaskMemory` qua nguong:

- khong append summary vo han
- rewrite thanh mot ban ngan hon
- giu lai:
  - goal
  - objective
  - completed
  - pending
  - blockers
  - filesTouched
  - handoffSummary moi nhat

Neu `projectMemory` qua nguong:

- rewrite `summary`
- cat gon `recentDecisions`
- chi giu conventions/pitfalls quan trong

## Prompt design

Prompt context nen theo thu tu:

1. notes
2. project memory
3. active task memory
4. tool evidence block
5. working session context note
6. compact summary cua working session neu co
7. raw user message + raw context messages cua working session

## Cac nguyen tac quan trong

### Khong nhot raw file content vao memory dai han

Khong dua vao `activeTaskMemory` hay `projectMemory`:

- raw tool output dai
- raw diff dai
- raw attachment content day du
- raw document content day du

Nhung thu do chi nen nam o:

- transcript
- attachment store
- evidence cache
- diff store

### Memory dai han phai co cau truc

Neu `session 2` chi la mot doan summary tu do, AI Agent van se quen.

`session 2` phai la:

- `activeTaskMemory`
- `projectMemory`

va phai co field ro rang de prompt builder co the lay dung thu can thiet.

## Cong viec can lam cho `galaxy-vscode-extension`

1. Doi `SessionMemory` tu dang cu sang dang moi:
- `activeTaskMemory`
- `projectMemory`
- `keyFiles` tong hop

2. Them migration tu format cu:
- `rollingSummary`
- `recentDigests`
- `openItems`
- `keyFiles`

3. Refactor `history-manager`
- update structured memory khi finalize
- rollover `workingSession` khi vuot nguong
- compact `activeTaskMemory` va `projectMemory`

4. Refactor `prompt-builder`
- inject `projectMemory`
- inject `activeTaskMemory`
- report token theo tung lop

5. Chuan hoa `% token`
- bao gom fixed overhead
- bao gom memory dai han
- bao gom evidence
- bao gom working session

6. Giu `uiTranscript` rieng
- khong dung lam prompt raw

## Thu tu trien khai khuyen nghi

1. Cap nhat type va store
2. Them migration tu session-memory cu
3. Refactor history manager
4. Refactor prompt builder
5. Sua token accounting
6. Chay typecheck/lint

## Ghi chu cho `galaxy-code`

Sau khi `galaxy-vscode-extension` on dinh, co the ap dung lai y nguyen cho `galaxy-code`:

- cung mo hinh 4 lop
- cung rollover logic
- cung cong thuc token

nhung nen trien khai sau de tranh sua dong thoi ca 2 he thong.
