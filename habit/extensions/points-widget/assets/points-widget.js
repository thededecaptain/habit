(function () {
  function money(n) {
    return "$" + Number(n).toFixed(2);
  }

  function nextTierLine(data) {
    if (!data.nextTierName) return "";
    var spend = data.nextTierRemainingSpend;
    var orders = data.nextTierRemainingOrders;
    var bits = [];
    if (spend != null && spend > 0) bits.push("Spend " + money(spend) + " more");
    if (orders != null && orders > 0) {
      bits.push("place " + orders + " more order" + (orders === 1 ? "" : "s"));
    }
    if (!bits.length) return "";
    return bits.join(" and ") + " to reach " + data.nextTierName;
  }

  function earnLine(root, data, loggedIn) {
    var cents = Number(root.getAttribute("data-product-price-cents") || 0);
    var rate = Number(data.pointsPerDollar || 0);
    var mult = loggedIn ? Number(data.earnMultiplier || 1) : 1;
    if (!cents || !rate) return "";
    var pts = Math.floor((cents / 100) * rate * mult);
    if (pts <= 0) return "";
    if (!loggedIn) return "Earn ~" + pts.toLocaleString() + " points on this product.";
    return "This product would earn " + pts.toLocaleString() + " points.";
  }

  function initWidget(root) {
    var proxyUrl = root.getAttribute("data-proxy-url");
    var loadingEl = root.querySelector("[data-habit-loading]");
    var loggedInEl = root.querySelector("[data-habit-loggedin]");
    var guestEl = root.querySelector("[data-habit-guest]");

    fetch(proxyUrl + "/balance")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (loadingEl) loadingEl.hidden = true;

        if (!data.loggedIn) {
          if (guestEl) {
            guestEl.hidden = false;
            var guestContext = guestEl.querySelector("[data-habit-guest-context]");
            var earn = earnLine(root, data, false);
            var rateLine =
              data.pointsPerDollar > 0
                ? "Earn " + data.pointsPerDollar + " points per $1 spent."
                : "";
            if (guestContext) guestContext.textContent = [earn, rateLine].filter(Boolean).join(" ");
          }
          return;
        }

        if (!loggedInEl) return;
        loggedInEl.hidden = false;

        var balanceEl = root.querySelector("[data-habit-balance]");
        if (balanceEl) balanceEl.textContent = Number(data.pointsBalance || 0).toLocaleString();

        var valueEl = root.querySelector("[data-habit-value]");
        if (valueEl && data.redemptionRate) {
          valueEl.hidden = false;
          valueEl.textContent = "· " + money(data.balanceValue != null ? data.balanceValue : data.pointsBalance / data.redemptionRate);
        }

        var contextEl = root.querySelector("[data-habit-context]");
        var earn = earnLine(root, data, true);
        if (contextEl && earn) {
          contextEl.hidden = false;
          contextEl.textContent = earn;
        }

        var cartLink = root.querySelector("[data-habit-cart-link]");
        if (cartLink) {
          cartLink.hidden = !(data.pointsBalance >= (data.minRedeemablePoints || 0) && data.redemptionRate);
        }

        var tierEl = root.querySelector("[data-habit-tier]");
        if (tierEl && data.tierName) {
          tierEl.hidden = false;
          tierEl.textContent = data.tierName + " tier";
        }

        var nextTierEl = root.querySelector("[data-habit-next-tier]");
        var nextLine = nextTierLine(data);
        if (nextTierEl && nextLine) {
          nextTierEl.hidden = false;
          nextTierEl.textContent = nextLine;
        }

        var expiryEl = root.querySelector("[data-habit-expiry]");
        var expiresInDays = Number(data.expiresInDays);
        if (
          expiryEl &&
          data.pointsBalance > 0 &&
          expiresInDays > 0 &&
          expiresInDays <= 30
        ) {
          expiryEl.hidden = false;
          expiryEl.textContent =
            expiresInDays === 1
              ? "Your points expire in 1 day."
              : "Your points expire in " + expiresInDays + " days.";
        }

        var codeEl = root.querySelector("[data-habit-referral-code]");
        var getCodeBtn = root.querySelector("[data-habit-get-code]");
        var copyBtn = root.querySelector("[data-habit-copy-code]");

        if (data.referralCode && codeEl) {
          codeEl.textContent = data.referralCode;
          if (getCodeBtn) getCodeBtn.hidden = true;
          if (copyBtn) copyBtn.hidden = false;
        }

        function requestCode() {
          var statusEl = root.querySelector("[data-habit-referral-status]");
          fetch(proxyUrl + "/referral-code" + window.location.search, { method: "POST" })
            .then(function (res) {
              return res.json();
            })
            .then(function (result) {
              if (result.error) {
                if (statusEl) statusEl.textContent = result.error;
                return;
              }
              if (codeEl) codeEl.textContent = result.code;
              if (getCodeBtn) getCodeBtn.hidden = true;
              if (copyBtn) copyBtn.hidden = false;
            })
            .catch(function () {
              if (statusEl) statusEl.textContent = "Something went wrong. Try again later.";
            });
        }

        if (getCodeBtn) getCodeBtn.addEventListener("click", requestCode);
        if (copyBtn) {
          copyBtn.addEventListener("click", function () {
            var statusEl = root.querySelector("[data-habit-referral-status]");
            navigator.clipboard
              ?.writeText(codeEl ? codeEl.textContent : "")
              .then(function () {
                if (statusEl) statusEl.textContent = "Copied";
              });
          });
        }
      })
      .catch(function () {
        if (loadingEl) loadingEl.textContent = "Couldn't load your rewards right now.";
      });
  }

  document.querySelectorAll("[data-habit-widget]").forEach(initWidget);
})();
