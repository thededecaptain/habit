// Cart "Have a referral code?" field. Injected next to the cart's checkout
// button by redeem-points.js; kept in its own file so each script stays
// under Shopify's app-block JavaScript size limit.
(function () {
  if (window.HabitReferral) return;

  function q(root, sel) {
    return (root || document).querySelector(sel);
  }

  function saveCartAttributes(attributes) {
    return fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ attributes: attributes }),
    }).then(function (r) {
      if (!r.ok) throw new Error("update");
      return r.json();
    });
  }

  function init(root, cart) {
    if (!root || root.getAttribute("data-habit-ready") === "1") return;
    root.setAttribute("data-habit-ready", "1");

    var proxy = root.getAttribute("data-proxy-url") || "/apps/habit";
    var details = q(root, "[data-habit-referral-details]");
    var input = q(root, "[data-habit-referral-input]");
    var applyBtn = q(root, "[data-habit-referral-apply]");
    var removeBtn = q(root, "[data-habit-referral-remove]");
    var status = q(root, "[data-habit-referral-status]");
    if (!input || !applyBtn) return;

    var applied = (cart && cart.attributes && cart.attributes.referral_code) || "";

    function paint(message) {
      input.value = applied || input.value;
      if (removeBtn) removeBtn.hidden = !applied;
      applyBtn.textContent = applied ? "Update code" : applyBtn.getAttribute("data-label");
      if (status) status.textContent = message || "";
    }

    function busy(on) {
      applyBtn.disabled = on;
      input.disabled = on;
      if (removeBtn) removeBtn.disabled = on;
    }

    function save(code, message) {
      return saveCartAttributes({ referral_code: code }).then(function (updated) {
        applied = code;
        paint(message);
        document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: updated } }));
      });
    }

    applyBtn.setAttribute("data-label", applyBtn.textContent.trim());
    if (applied) {
      if (details) details.open = true;
      paint("Code " + applied + " applied. Bonus points arrive after your order.");
    }

    applyBtn.addEventListener("click", function () {
      var code = input.value.trim().toUpperCase();
      if (!code) {
        if (status) status.textContent = "Enter a referral code.";
        return;
      }
      busy(true);
      if (status) status.textContent = "Checking…";
      fetch(proxy + "/referral-check?code=" + encodeURIComponent(code), { credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!data.valid) {
            if (status) status.textContent = data.error || "That code can't be used.";
            return;
          }
          var bonus = Number(data.refereeBonusPoints || 0);
          return save(
            data.code,
            "Code " + data.code + " applied." +
              (bonus ? " You'll get " + bonus.toLocaleString() + " bonus points after your order." : ""),
          );
        })
        .catch(function () {
          if (status) status.textContent = "Couldn't apply the code — try again.";
        })
        .then(function () {
          busy(false);
        });
    });

    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        busy(true);
        input.value = "";
        save("", "Referral code removed.")
          .catch(function () {
            if (status) status.textContent = "Couldn't update cart — try again.";
          })
          .then(function () {
            busy(false);
          });
      });
    }
  }

  function inject(btn, cart) {
    if (!btn || cart.item_count < 1) return;
    if (btn.closest("[data-habit-referral]")) return;
    var ctas = btn.closest(".cart__ctas");
    var parent =
      ctas ||
      btn.closest(".drawer__footer") ||
      btn.closest(".cart-drawer__footer") ||
      btn.parentElement;
    if (!parent) return;
    var scope = ctas ? ctas.parentElement : parent;
    if (scope && scope.querySelector("[data-habit-referral]")) return;

    var t = document.getElementById("habit-referral-template");
    var widget = t && t.content ? t.content.firstElementChild.cloneNode(true) : null;
    if (!widget) return;
    if (ctas && ctas.parentElement) ctas.parentElement.insertBefore(widget, ctas);
    else parent.insertBefore(widget, btn);
    init(widget, cart);
  }

  window.HabitReferral = { inject: inject };
  if (window.__habitRedeemRefresh) window.__habitRedeemRefresh();
})();
