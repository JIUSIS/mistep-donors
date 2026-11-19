"use strict";

const contentsUrl = "https://api.github.com/repos/JIUSIS/mistep-donors/contents/donors.json";
const liveUrl = new URL("../donors.json", location.href);
const maxNames = 500;
const maxBytes = 64 * 1024;
const byId = (id) => document.getElementById(id);
const ui = {
  status: byId("status"), statusText: byId("status-text"), reload: byId("reload"),
  publish: byId("publish"), add: byId("add"), newName: byId("new-name"),
  rows: byId("names"), template: byId("name-row"), empty: byId("names-empty"),
  count: byId("count"), preview: byId("preview-names"), previewEmpty: byId("preview-empty"),
  error: byId("edit-error"), dialog: byId("authorization"), token: byId("token"),
  confirm: byId("confirm-publish"), close: byId("close-auth"), authError: byId("auth-error"),
  githubEdit: byId("github-edit"), publishJson: byId("publish-json"), copyStatus: byId("copy-status"),
  tokenOption: byId("token-option"),
};

let rows = [];
let baseline = [];
let blob = "";
let token = "";
let busy = false;
let observation = 0;
let liveStatus = ["pending", "正在读取名单"];

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validName(value) {
  return value.length > 0 && [...value].length <= 64 && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
}

function namesIn(document) {
  if (!Array.isArray(document?.donors) || document.donors.length > maxNames ||
      !document.donors.every((name) => typeof name === "string" && validName(name.trim()))) {
    throw new Error("名单文件格式无效");
  }
  return document.donors.map((name) => name.trim());
}

function currentNames() {
  return rows.map(({ value }) => value.trim());
}

function hasDraft() {
  return !sameList(currentNames(), baseline) || !!ui.newName.value.trim();
}

function status(kind, message) {
  liveStatus = [kind, message];
  renderStatus();
}

function renderStatus() {
  const [kind, message] = liveStatus;
  const draft = hasDraft() && kind !== "error";
  ui.status.dataset.kind = draft ? "pending" : kind;
  ui.statusText.textContent = draft ? `${message} · 有未发布修改` : message;
}

function showError(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

function refreshControls() {
  const names = currentNames();
  const editable = !!blob && !busy;
  ui.publish.disabled = !editable || !hasDraft();
  ui.reload.disabled = busy;
  ui.newName.disabled = !editable;
  ui.add.disabled = !editable || !ui.newName.value.trim();
  ui.empty.hidden = rows.length > 0;
  ui.count.textContent = `${rows.length} 人`;
  ui.rows.querySelectorAll("input, button").forEach((control) => { control.disabled = !editable; });
  const visible = names.filter(validName);
  const items = visible.map((name) => {
    const item = document.createElement("li");
    item.textContent = name;
    return item;
  });
  ui.preview.replaceChildren(...items);
  ui.previewEmpty.hidden = items.length > 0;
  renderStatus();
}

function renderRows() {
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const node = ui.template.content.firstElementChild.cloneNode(true);
    const input = node.querySelector("input");
    input.value = row.value;
    input.setAttribute("aria-label", "昵称");
    input.addEventListener("input", () => {
      row.value = input.value;
      input.setAttribute("aria-invalid", String(!validName(row.value.trim())));
      showError(ui.error);
      refreshControls();
    });
    const remove = node.querySelector('[data-action="remove"]');
    remove.setAttribute("aria-label", "删除昵称");
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(row), 1);
      showError(ui.error);
      renderRows();
      ui.newName.focus();
    });
    fragment.append(node);
  });
  ui.rows.replaceChildren(fragment);
  refreshControls();
}

function addName() {
  const value = ui.newName.value.trim();
  if (!validName(value)) {
    showError(ui.error, "昵称须为 1 至 64 个字符，不能包含换行或控制字符。");
    ui.newName.focus();
    return false;
  }
  if (rows.length >= maxNames) {
    showError(ui.error, "名单最多可包含 500 人。");
    return false;
  }
  rows.push({ value });
  ui.newName.value = "";
  showError(ui.error);
  renderRows();
  return true;
}

async function request(url, options = {}) {
  return fetch(url, {
    cache: "no-store", credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(12000), ...options,
  });
}

async function readRepository() {
  const response = await request(`${contentsUrl}?ref=main`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub 读取失败（${response.status}）`);
  const doc = await response.json();
  if (!/^[0-9a-f]{40}$/.test(doc.sha) || doc.type !== "file" || doc.encoding !== "base64" ||
      typeof doc.content !== "string" || doc.size > maxBytes) {
    throw new Error("名单文件格式无效");
  }
  const bytes = Uint8Array.from(atob(doc.content), (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes) throw new Error("名单文件超出大小限制");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { blob: doc.sha, names: namesIn(JSON.parse(decoded)) };
}

async function watchLive(expected) {
  const ticket = ++observation;
  for (let attempt = 0; attempt < 61; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10000));
    if (ticket !== observation) return;
    try {
      const response = await request(liveUrl);
      if (response.ok && sameList(expected, namesIn(await response.json()))) {
        if (ticket === observation) status("ok", "公开名单已更新");
        return;
      }
    } catch {
      // A failed read does not tell us whether Pages finished publishing.
    }
  }
  if (ticket === observation) status("pending", "尚未读到新版本，可重新读取名单");
}

async function load() {
  if (busy || (hasDraft() && !confirm("重新读取会清除未发布的修改。继续？"))) return;
  busy = true;
  observation++;
  status("pending", "正在读取名单");
  refreshControls();
  try {
    const latest = await readRepository();
    blob = latest.blob;
    baseline = latest.names;
    rows = baseline.map((value) => ({ value }));
    ui.newName.value = "";
    showError(ui.error);
    status("pending", "名单已读取，正在检查公开版本");
    void watchLive(baseline);
  } catch (error) {
    status("error", `暂时无法读取仓库。${error.message}`);
  } finally {
    busy = false;
    renderRows();
  }
}

function donorDocument(names) {
  return `${JSON.stringify({ donors: names }, null, 2)}\n`;
}

function publishError(code) {
  if (code === 401 || code === 403) return "GitHub 拒绝授权，请检查 Token 有效期和 Contents 写入权限。";
  if (code === 409 || code === 422) return "GitHub 未接受发布。请核对名单是否已在其他地方更新，再重新读取。";
  return `GitHub 发布失败（${code}）。`;
}

async function publish() {
  if (busy || !blob || !token) return;
  const names = currentNames();
  const bytes = new TextEncoder().encode(donorDocument(names));
  const invalid = names.findIndex((name) => !validName(name));
  if (invalid !== -1 || names.length > maxNames || bytes.length > maxBytes) {
    status("error", "请检查昵称长度和名单大小。");
    return;
  }
  busy = true;
  observation++;
  ui.confirm.disabled = true;
  ui.close.disabled = true;
  ui.token.disabled = true;
  showError(ui.authError);
  status("pending", "正在提交名单");
  refreshControls();
  try {
    const response = await request(contentsUrl, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch: "main", sha: blob, message: "Update MiStep donor acknowledgments",
        content: btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join("")),
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) token = "";
      throw new Error(publishError(response.status));
    }
    const result = await response.json();
    if (!/^[0-9a-f]{40}$/.test(result.content?.sha ?? "")) throw new Error("未收到提交确认，请重新读取名单。");
    blob = result.content.sha;
    baseline = names;
    rows = names.map((value) => ({ value }));
    ui.dialog.close();
    status("pending", "名单已提交，等待 GitHub Pages 发布");
    void watchLive(baseline);
  } catch (error) {
    const message = ["TimeoutError", "TypeError"].includes(error.name)
      ? "提交结果未知，请先在名单仓库确认是否已有新提交。" : error.message;
    if (ui.dialog.open) showError(ui.authError, message);
    status("error", message);
  } finally {
    busy = false;
    ui.confirm.disabled = false;
    ui.close.disabled = false;
    ui.token.disabled = false;
    renderRows();
  }
}

byId("add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!busy && blob && addName()) ui.newName.focus();
});
ui.newName.addEventListener("input", () => {
  showError(ui.error);
  refreshControls();
});
ui.reload.addEventListener("click", load);
ui.publish.addEventListener("click", () => {
  if (ui.newName.value.trim() && !addName()) return;
  if (!hasDraft()) return;
  const invalid = currentNames().findIndex((name) => !validName(name));
  if (invalid !== -1) {
    showError(ui.error, "有昵称无效，请检查后再发布。");
    ui.rows.children[invalid].querySelector("input").focus();
    return;
  }
  const document = donorDocument(currentNames());
  if (new TextEncoder().encode(document).length > maxBytes) {
    showError(ui.error, "名单文件超出大小限制。");
    return;
  }
  if (token) void publish();
  else {
    ui.publishJson.value = document;
    ui.publishJson.hidden = true;
    ui.copyStatus.hidden = true;
    ui.tokenOption.open = false;
    showError(ui.authError);
    ui.dialog.showModal();
    ui.githubEdit.focus();
  }
});
ui.githubEdit.addEventListener("click", async (event) => {
  if (busy) {
    event.preventDefault();
    return;
  }
  ui.copyStatus.hidden = false;
  try {
    await navigator.clipboard.writeText(ui.publishJson.value);
    ui.copyStatus.textContent = "已复制，粘贴后在 GitHub 提交即可。";
  } catch {
    ui.copyStatus.textContent = "自动复制失败，请手动复制下方名单。";
    ui.publishJson.hidden = false;
    ui.publishJson.select();
  }
});
byId("publish-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const value = ui.token.value.trim();
  if (!/^github_pat_[A-Za-z0-9_]+$/.test(value)) {
    showError(ui.authError, "请输入 GitHub 细粒度 Token。");
    return;
  }
  ui.token.value = "";
  token = value;
  void publish();
});
ui.close.addEventListener("click", () => ui.dialog.close());
ui.dialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
ui.dialog.addEventListener("close", () => { ui.token.value = ""; });
window.addEventListener("beforeunload", (event) => {
  if (busy || hasDraft()) {
    event.preventDefault();
    event.returnValue = true;
  }
});
window.addEventListener("pagehide", () => { token = ""; ui.token.value = ""; });
void load();
