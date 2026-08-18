(function () {
  if (window.__habitRedeemLoaded) return;
  window.__habitRedeemLoaded = true;

  var CHECKOUT = [
    "#CartDrawer-Checkout",
    "cart-drawer [name='checkout']",
    "#CartDrawer [name='checkout']",
    ".cart-drawer [name='checkout']",
    ".drawer__footer [name='checkout']",
    "form[action='/cart'] [name='checkout']",
    "form[action$='/cart'] [name='checkout']",
  ];
  var timer;

  function q(root, sel) {
    return (root || document).querySelector(sel);
  }

  function money(n) {
    return "$" + Number(n).toFixed(2);
  }

  function cloneTemplate() {
    var t = document.getElementById("habit-redeem-template");
    return t && t.content ? t.content.firstElementChild.cloneNode(true) : null;
  }

  function cartJson() {
    return fetch("/cart.js", { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("cart");
      return r.json();
    });
  }

  function initRedeem(root, cart) {
    if (!root || root.getAttribute("data-habit-ready") === "1") return;
    root.setAttribute("data-habit-ready", "1");

    var proxy = root.getAttribute("data-proxy-url") || "/apps/habit";
    var loading = q(root, "[data-habit-loading]");
    var body = q(root, "[data-habit-redeem-body]");
    if (!body) {
      root.hidden = true;
      return;
    }

    var balanceEl = q(root, "[data-habit-balance]");
    var valueEl = q(root, "[data-habit-value]");
    var balanceText = q(root, "[data-habit-redeem-balance-text]");
    var appliedLine = q(root, "[data-habit-applied-line]");
    var input = q(root, "[data-habit-redeem-input]");
    var details = q(root, "[data-habit-redeem-details]");
    var preview = q(root, "[data-habit-redeem-preview]");
    var applyBtn = q(root, "[data-habit-redeem-apply]");
    var removeBtn = q(root, "[data-habit-redeem-remove]");
    var status = q(root, "[data-habit-redeem-status]");
    var subtotal =
      cart && typeof cart.total_price === "number"
        ? cart.total_price
        : Number(root.getAttribute("data-cart-subtotal-cents") || 0);
    var applied =
      cart && cart.attributes && cart.attributes.points_to_redeem != null
        ? Number(cart.attributes.points_to_redeem)
        : Number(root.getAttribute("data-applied-points") || 0);

    fetch(proxy + "/balance" + window.location.search)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (loading) loading.hidden = true;
        if (!data.loggedIn) {
          root.hidden = true;
          return;
        }

        var balance = Number(data.pointsBalance || 0);
        var rate = Number(data.redemptionRate || 0);
        var min = Number(data.minRedeemablePoints || 0);
        var cap = Number(data.maxRedemptionPercent || 0);
        var byPct = cap ? Math.floor((subtotal / 100) * (cap / 100) * rate) : balance;
        var maxPts = Math.max(0, Math.min(balance, byPct));
        if ((!rate || maxPts < min) && applied <= 0) {
          root.hidden = true;
          return;
        }

        root.hidden = false;
        body.hidden = false;
        if (balanceEl) balanceEl.textContent = balance.toLocaleString();
        if (valueEl && rate) {
          valueEl.hidden = false;
          valueEl.textContent =
            "· " + money(data.balanceValue != null ? data.balanceValue : balance / rate);
        }
        if (balanceText) {
          balanceText.textContent = "Redeem on this order. Discount appears at checkout.";
        }
        if (!input || !applyBtn) return;

        input.min = "0";
        input.max = String(maxPts);
        input.step = String(min || 1);
        input.value = String(Math.min(applied, maxPts) || (applied > 0 ? applied : min));
        if (details) {
          details.hidden = false;
          details.textContent =
            "Up to " + maxPts.toLocaleString() + " points (" + money(maxPts / rate) + ").";
        }

        function paintApplied() {
          var dollars = applied > 0 ? applied / rate : 0;
          root.classList.toggle("habit-widget--applied", applied > 0);
          if (appliedLine) {
            appliedLine.hidden = applied <= 0;
            appliedLine.textContent =
              applied > 0
                ? "Applied · " + applied.toLocaleString() + " points (" + money(dollars) + " off at checkout)"
                : "";
          }
          if (removeBtn) removeBtn.hidden = applied <= 0;
        }

        function previewText() {
          var n = Math.max(0, Math.min(Number(input.value) || 0, maxPts));
          if (preview) {
            preview.hidden = false;
            preview.textContent =
              n > 0
                ? "You’ll save " + money(n / rate) + " at checkout"
                : "Choose how many points to redeem.";
          }
          applyBtn.textContent = applied > 0 ? "Update points" : "Apply points";
        }

        input.addEventListener("input", previewText);
        previewText();
        paintApplied();

        function busy(on) {
          applyBtn.disabled = on;
          input.disabled = on;
          if (removeBtn) removeBtn.disabled = on;
        }

        function save(n) {
          busy(true);
          if (status) status.textContent = "Saving…";
          fetch("/cart/update.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ attributes: { points_to_redeem: String(n) } }),
          })
            .then(function (r) {
              if (!r.ok) throw new Error("update");
              return r.json();
            })
            .then(function (updated) {
              applied = n;
              root.setAttribute("data-applied-points", String(n));
              if (status) {
                status.textContent =
                  n > 0 ? "Saved. Your discount shows at checkout." : "Redemption removed.";
              }
              paintApplied();
              previewText();
              busy(false);
              document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: updated } }));
            })
            .catch(function () {
              busy(false);
              if (status) status.textContent = "Couldn't update your cart — try again.";
            });
        }

        applyBtn.addEventListener("click", function () {
          save(Math.max(0, Math.min(Number(input.value) || 0, maxPts)));
        });
        if (removeBtn) {
          removeBtn.addEventListener("click", function () {
            input.value = "0";
            previewText();
            save(0);
          });
        }
      })
      .catch(function () {
        if (loading) loading.textContent = "Couldn't load your rewards right now.";
      });
  }

  function checkoutButtons() {
    var list = [];
    CHECKOUT.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (btn) {
        if (list.indexOf(btn) === -1) list.push(btn);
      });
    });
    return list;
  }

  function hasWidget(node) {
    return !!(node && node.querySelector && node.querySelector("[data-habit-redeem]"));
  }

  function inject(btn, cart) {
    if (!btn || cart.item_count < 1) return;
    var parent =
      btn.closest(".cart__ctas") ||
      btn.closest(".drawer__footer") ||
      btn.closest(".cart-drawer__footer") ||
      btn.parentElement;
    if (!parent || hasWidget(parent) || hasWidget(parent.parentElement)) return;
    if (btn.closest("[data-habit-redeem]")) return;

    var widget = cloneTemplate();
    if (!widget) return;
    widget.setAttribute("data-cart-subtotal-cents", String(cart.total_price || 0));
    widget.setAttribute(
      "data-applied-points",
      String((cart.attributes && cart.attributes.points_to_redeem) || 0),
    );
    var ctas = btn.closest(".cart__ctas");
    if (ctas && ctas.parentElement) ctas.parentElement.insertBefore(widget, ctas);
    else parent.insertBefore(widget, btn);
    initRedeem(widget, cart);
  }

  function ensure() {
    document.querySelectorAll("[data-habit-redeem]:not([data-habit-ready])").forEach(function (el) {
      initRedeem(el, null);
    });
    if (!document.getElementById("habit-redeem-template")) return;
    cartJson()
      .then(function (cart) {
        checkoutButtons().forEach(function (btn) {
          inject(btn, cart);
        });
      })
      .catch(function () {});
  }

  function later() {
    clearTimeout(timer);
    timer = setTimeout(ensure, 150);
  }

  document.querySelectorAll("[data-habit-redeem]").forEach(function (el) {
    initRedeem(el, null);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", later);
  else later();

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.closest && (t.closest("[href='/cart']") || t.closest(".header__icon--cart"))) later();
  });

  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType !== 1) continue;
          if (n.getAttribute && n.getAttribute("data-habit-redeem") != null) continue;
          var s = (n.id || "") + " " + (n.className || "") + " " + (n.tagName || "");
          if (/cart|drawer|checkout/i.test(s)) {
            later();
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (typeof window.fetch === "function") {
    var orig = window.fetch;
    window.fetch = function () {
      var p = orig.apply(this, arguments);
      try {
        if (/\/cart\/(add|change|update|clear)/.test(String(arguments[0] || ""))) p.then(later);
      } catch (e) {}
      return p;
    };
  }
})();
