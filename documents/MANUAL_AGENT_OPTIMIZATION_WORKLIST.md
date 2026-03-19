# Manual Agent Optimization Worklist

## Muc tieu

Toi uu `manual` agent theo dung boi canh hien tai va giu `galaxy-code` dong nhat voi `galaxy-vscode-extension`.

Phan uu tien:

- model mac dinh la `qwen3.5:397b-cloud`
- uu tien kha nang `thinking` + doc hieu image
- chua tinh chinh runtime params cua Ollama request
- tap trung vao context engineering, token budget, va freshness cua evidence

## Trang thai hien tai

Da implement:

- token estimator tot hon thay cho `chars / 3.5`
- dynamic budget theo `total prompt`
- stale invalidation manh hon cho `run_project_command` va Galaxy Design actions
- prompt rieng hon cho `manual`
- `galaxy-code` da duoc keo ve tool surface gan voi `galaxy-vscode-extension`

Chua implement:

- tuning runtime params cua `manual`
- embedding layer / semantic retrieval

## Hien trang sau khi sua

### Driver

`manual` dang:

- goi Ollama cloud qua `https://ollama.com`
- fallback model sang `qwen3.5:397b-cloud`
- bat `think` cho nhom model `qwen|deepseek|r1`
- chua set rieng `temperature`, `top_p`, `keep_alive`, `num_ctx`

File lien quan:

- `src/runtime/drivers/manual.ts`

### Session va token

He thong da co:

- `workingTurn`
- `activeTaskMemory`
- `projectMemory`
- `tool evidence`
- `prompt builder` tach lop context

Budget khong con dua vao reserve cung theo kieu:

- `FIXED_CONTEXT_BUFFER_TOKENS = 96_000`

Ma dua theo:

- `SOFT_PROMPT_TOKENS = 228_000`
- `HARD_PROMPT_TOKENS = 238_000`
- `MIN_WORKING_CONTEXT_TOKENS = 64_000`
- `computeWorkingContextBudget(...)`

File lien quan:

- `src/context/history-manager.ts`
- `src/context/prompt-builder.ts`
- `src/runtime/run-chat.ts`
- `src/context/compaction.ts`

### Token estimation

Estimator hien tai:

- uu tien `js-tiktoken` voi `o200k_base`
- neu khong load duoc moi fallback ve `chars / 3.5`

File lien quan:

- `src/context/compaction.ts`

### Tool evidence

Stale invalidation da duoc nang cap cho:

- `write_file`
- `edit_file`
- `revert_file`
- `run_project_command`
- `galaxy_design_init`
- `galaxy_design_add`

File lien quan:

- `src/context/tool-evidence-selector.ts`

### System prompt

System prompt hien tai van dung chung khung lon, nhung `manual` da co them mot lop huong dan rieng o:

- just-in-time retrieval
- shallow `list_dir`
- chunked read
- approval boundaries
- same-language response
- image-first workflow
- long-context discipline
- project-command freshness
- tool batching

File lien quan:

- `src/runtime/system-prompt.ts`

## Cong viec da thuc hien

### 1. Chuyen budget sang dynamic budget

Khong nen giu `FIXED_CONTEXT_BUFFER_TOKENS = 96_000` nhu mot reserve cung cho moi turn.

Nen tinh budget theo overhead thuc te cua prompt:

1. `systemPromptTokens`
2. `toolSchemaTokens`
3. memory tokens
4. evidence tokens
5. response reserve
6. safety margin

Khong nen dat muc tieu la de `workingTurn` cham sat `256k`.

Ly do:

- `256k` la tran cua toan bo request, khong phai chi rieng `workingTurn`
- ngoai `workingTurn` con co `system prompt`, `tool schema`, `activeTaskMemory`, `projectMemory`, `evidence`, va co the co them `permissions block`
- estimator hien tai van co sai so, nen di sat mep se de vuot tran

Vi vay, thay vi mot cap co dinh `192k`, nen tinh theo tong prompt usage va chi compact khi tong context tien gan nguong an toan.

Cong thuc de xuat:

```ts
dynamicOverhead =
  systemPromptTokens +
  toolSchemaTokens +
  evidenceTokens +
  permissionBlockTokens

responseReserve = 24_000
safetyMargin = 12_000

softPromptCap = 228_000
hardPromptCap = 238_000
workingBudget =
  clamp(
    softPromptCap
      - dynamicOverhead
      - activeTaskMemoryTokens
      - projectMemoryTokens,
    workingBudgetFloor,
    MAX_TOKENS
  )
```

Nguyen tac:

- `workingBudgetFloor = 64_000` la muc toi thieu danh rieng cho `workingTurn`
- day khong phai la tong context budget cua ca request
- floor nay de tranh truong hop memory + overhead an het budget, khien `workingTurn` bi ep qua nho va compact lien tuc
- khi overhead thap, `workingTurn` co the lon hon 192k
- khi overhead cao, budget tu dong co lai de tranh cham tran 256k
- compact dua theo `total prompt`, khong dua theo mot moc co dinh duy nhat

Trang thai:

- da implement cho `galaxy-vscode-extension`
- da implement cho `galaxy-code`

### 2. Thay token estimator bang estimator tot hon

Khong nen tiep tuc dua vao `chars / 3.5` nhu bo do chinh.

Huong de xuat:

1. dung `js-tiktoken` lam preflight estimator
2. fallback ve `chars / 3.5` neu khong load duoc encoder
3. de kha nang log token thuc te tu Ollama response cho buoc sau

Luu y:

- `js-tiktoken` la tokenizer theo ho OpenAI, khong trung 100% voi Qwen
- nhung van tot hon `chars / 3.5`
- nen coi day la `better estimator`, khong phai `ground truth`

Neu Ollama stream chunk cuoi co tra:

- `prompt_eval_count`
- `eval_count`

thi nen luu log de so sanh:

- estimated prompt tokens
- real prompt tokens

Trang thai:

- da implement estimator moi
- chua log `prompt_eval_count`
- chua tinh correction factor theo runtime data that

### 3. Tang stale invalidation cho tool evidence

Y nghia cua "invalidation chua du" la:

- evidence cu van co the duoc tai su dung
- trong khi filesystem hoac project state da doi

Vi du:

1. agent doc `package.json`
2. agent `list_dir src`
3. agent chay `run_project_command("npm install")`
4. lockfile, `package.json`, `node_modules`, generated files, va tree du an co the da thay doi
5. evidence cu co the da stale nhung van duoc dua lai vao prompt

Huong de xuat:

- `write_file`, `edit_file`
  - invalidate exact file
  - invalidate parent directory
- `galaxy_design_init`, `galaxy_design_add`
  - invalidate target subtree
- `run_project_command`
  - neu command thuoc nhom `install`, `scaffold`, `git checkout`, `git pull`, `codegen`, `format --write`
    - invalidate theo `cwd` subtree
  - neu command chi la `test`, `lint`, `typecheck`
    - khong invalidate manh neu khong phat sinh file moi

Muc tieu:

- evidence builder uu tien ket qua moi hon
- giam nguy co model lap lai suy luan tren du lieu cu

Trang thai:

- da implement cho `run_project_command`
- da implement cho `galaxy_design_init`
- da implement cho `galaxy_design_add`
- `galaxy-code` da bo luon nhom legacy mutate tools khoi tool surface cua agent

### 4. Tailor system prompt rieng cho `manual`

Khong can rewrite lon. Chi can them mot lop huong dan ngan, dung trong bai toan cua `qwen3.5:397b-cloud`.

De xuat them 4 nhom rule:

#### Image-first workflow

Neu co image attachment:

- truoc khi sua code, xac dinh layout
- hierarchy
- interactions
- constraints
- roi map sang file/component can sua

#### Long-context discipline

- khong doc lai cung file chunk nhieu lan
- khi da du evidence thi ngung explore
- uu tien chuyen sang edit hoac tra loi

#### Project-command freshness

- sau `run_project_command`, khong mac dinh tin lai evidence cu
- refresh file hoac directory lien quan truoc khi suy luan tiep

#### Tool batching

- uu tien `list_dir(depth=1)` + `grep` + `read_file(offset, maxLines)`
- tranh full read lap lai tren nhieu file dai

### 5. Khong doi runtime params o giai doan nay

Tam thoi giu mac dinh cho:

- `temperature`
- `top_p`
- `keep_alive`
- `num_ctx`

Ly do:

- user muon theo doi chat luong voi default truoc
- neu ket qua chua on moi can tune sau

## Standardization voi `galaxy-code`

`galaxy-code` da duoc keo ve huong cua `galaxy-vscode-extension`:

- giu `run_project_command` linh hoat theo `command + cwd + maxChars`
- khong expose nua cac tool legacy nhu `delete_path`, `git_*`, `scaffold_project`
- approval flow uu tien theo command thuc te
- prompt va stale invalidation di cung triet ly voi ban VS Code

## Thu tu tiep theo

Neu muon toi uu them, thu tu hop ly la:

1. theo doi chat luong `manual` voi runtime params mac dinh
2. log `prompt_eval_count` neu Ollama tra ve
3. can nhac them semantic retrieval / embedding layer khi heuristic retrieval khong du

Nen lam theo thu tu rui ro thap truoc:

1. doi token estimator
2. chuyen budget sang dynamic
3. tang invalidation cho tool evidence
4. tailor system prompt cho `manual`

Khong nen lam cung luc qua nhieu thay doi vi se kho biet cai nao tac dong toi chat luong that.

## Danh gia ve `qwen3-embedding`

## `qwen3-embedding` la gi

`qwen3-embedding` khong phai model chat/generate. Day la model embedding:

- nhan text dau vao
- tra ve vector so
- dung cho semantic search, retrieval, va RAG

No phu hop cho:

- text retrieval
- code retrieval
- text classification
- text clustering
- bitext mining

## Co ap dung duoc vao lap trinh de toi uu he thong khong

Co, nhung theo huong retrieval system, khong phai thay the model chat.

No co the co ich cho `galaxy-vscode-extension` o cac bai toan:

### Semantic file retrieval

Thay vi chi dua vao:

- path match
- grep
- recent files

co the index:

- source files
- docs
- design notes
- session summaries

roi retrieve theo nghia.

Vi du:

- user hoi "phan xu ly approval native o dau"
- embedding search co the tim ra `extension.ts`, `package.json`, `protocol.ts`
- ngay ca khi user khong go dung ten file

### Code-aware context selection

Co the dung embedding de chon:

- file nao nen doc truoc
- doan summary nao nen dua vao prompt
- evidence nao thuc su lien quan den task hien tai

### Doc / attachment retrieval

Rat hop cho:

- figma notes
- design docs
- markdown docs
- specs dai

Neu muon Agent hoi dap tren tap tai lieu lon ma khong can nhot het vao prompt.

## Co nen ap dung ngay khong

Chua nen xem day la uu tien so 1.

Ly do:

- he thong hien tai chua co vector store
- chua co indexing pipeline
- chua co chunking + embedding cache
- chua co retrieval layer de chen ket qua vao `prompt-builder`

Neu them `qwen3-embedding`, ban se phai xay them:

1. chunker cho file/doc
2. embedding index
3. vector similarity search
4. cache + invalidation khi file doi
5. retrieval policy trong prompt builder

Tuc la day la mot lop kien truc moi, khong phai chi thay model la xong.

## Ket luan

`qwen3-embedding` co y nghia va co the giup toi uu he thong agent, nhat la cho:

- semantic code retrieval
- context selection
- RAG tren docs lon

Nhung voi `galaxy-vscode-extension` hien tai, no nen duoc xem la:

- `phase sau`
- sau khi hoan thanh cac toi uu re va co tac dong truc tiep hon cho `manual`

Thu tu hop ly:

1. sua estimator
2. sua budget
3. sua invalidation
4. tailor prompt
5. neu van can retrieval thong minh hon, moi bat dau them embedding layer
