const API = ""; // same-origin

const $ = (id) => document.getElementById(id);

let deviceCode = null;

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "request_failed");
  return data;
}

$("startBtn").addEventListener("click", async () => {
  try {
    $("startBtn").disabled = true;

    const data = await api("/api/auth/device/start", { method: "POST" });

    deviceCode = data.device_code;

    $("step").style.display = "block";
    $("stepText").textContent = "1) Open GitHub and enter this code to authorize.";
    $("userCode").textContent = data.user_code;
    $("verifyLink").href = data.verification_uri;
    $("pollBtn").disabled = false;

    $("pollHint").textContent = "Then press “Check Login”. If pending, try again after a few seconds.";
  } catch (e) {
    alert(String(e.message || e));
    $("startBtn").disabled = false;
  }
});

$("copyBtn").addEventListener("click", async () => {
  const txt = $("userCode").textContent;
  try {
    await navigator.clipboard.writeText(txt);
    $("pollHint").textContent = "Copied code.";
  } catch {
    alert("Could not copy. Select and copy manually.");
  }
});

$("pollBtn").addEventListener("click", async () => {
  if (!deviceCode) return;
  try {
    $("pollBtn").disabled = true;
    $("pollHint").textContent = "Checking…";

    const data = await api("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: deviceCode })
    });

    if (data.ok) {
      $("stepText").textContent = `Signed in as ${data.login}.`;
      $("pollHint").textContent = "Success. You can open the app.";
      $("goAppBtn").disabled = false;
      return;
    }

    if (data.error === "authorization_pending") {
      $("pollHint").textContent = "Still pending — approve in GitHub then try again.";
    } else if (data.error === "slow_down") {
      $("pollHint").textContent = "GitHub says slow down — wait a bit longer and try again.";
    } else if (data.error === "expired_token") {
      $("pollHint").textContent = "Code expired — start again.";
      deviceCode = null;
      $("pollBtn").disabled = true;
      $("startBtn").disabled = false;
    } else {
      $("pollHint").textContent = `Error: ${data.error || "unknown"}`;
    }
  } catch (e) {
    alert(String(e.message || e));
  } finally {
    $("pollBtn").disabled = false;
  }
});

$("goAppBtn").addEventListener("click", () => {
  location.href = "app.html";
});
