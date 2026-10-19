/* eKarolBagh client: one place where the website and the app talk to the backend.
   Guests keep their cart and wishlist in this browser; after signing in they are merged
   into the account, so the same cart shows on the website and in the app. */
(function () {
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  async function call(method, path, body) {
    let r;
    try {
      r = await fetch("/api" + path, { method, credentials: "same-origin", headers: Object.assign({ "x-ekb": "1" }, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    } catch (e) { const err = new Error("No internet connection. Please check and try again."); err.code = "OFFLINE"; throw err; }
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((d && d.error) || "Something went wrong. Please try again."); e.code = d && d.code; e.status = r.status; throw e; }
    return d;
  }
  const st = { user: null, cart: LS.get("ekb-cart", {}), wl: LS.get("ekb-wl", {}), ready: false };
  const listeners = [];
  const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  const lines = () => Object.keys(st.cart).map((key) => ({ key, qty: st.cart[key] }));
  let pushT = null;
  function saveCart() {
    if (!st.user) { LS.set("ekb-cart", st.cart); return; }
    clearTimeout(pushT);
    pushT = setTimeout(() => call("PUT", "/cart", { items: lines() }).catch(() => {}), 350);
  }
  async function pullAccount(merge) {
    const items = lines(), ids = Object.keys(st.wl).map(Number);
    const c = merge && items.length ? await call("POST", "/cart/merge", { items }) : await call("GET", "/cart");
    st.cart = {}; c.items.forEach((i) => { st.cart[i.key] = i.qty; });
    const w = merge && ids.length ? await call("POST", "/wishlist/merge", { ids }) : await call("GET", "/wishlist");
    st.wl = {}; w.ids.forEach((i) => { st.wl[i] = 1; });
    LS.set("ekb-cart", {}); LS.set("ekb-wl", {});
  }
  async function signedIn(user) { st.user = user; await pullAccount(true).catch(() => {}); emit(); return user; }
  function signedOut() { st.user = null; st.cart = {}; st.wl = {}; emit(); }

  window.EKB = {
    state: st,
    onChange(f) { listeners.push(f); },
    async init() {
      try { const d = await call("GET", "/auth/me"); st.user = d.user; if (st.user) await pullAccount(false); } catch (e) {}
      st.ready = true; emit();
    },
    login: (email, password) => call("POST", "/auth/login", { email, password }).then((d) => signedIn(d.user)),
    signup: (b) => call("POST", "/auth/signup", b).then((d) => signedIn(d.user)),
    logout: () => call("POST", "/auth/logout").catch(() => {}).then(signedOut),
    forgot: (email) => call("POST", "/auth/forgot", { email }),
    reset: (token, password) => call("POST", "/auth/reset", { token, password }).then((d) => signedIn(d.user)),
    updateMe: (b) => call("PATCH", "/me", b).then((d) => { st.user = d.user; emit(); return d.user; }),
    changePassword: (current, password) => call("POST", "/me/password", { current, password }),
    deleteMe: (password) => call("DELETE", "/me", { password }).then(signedOut),

    setQty(key, q) { key = String(key); if (q > 0) st.cart[key] = Math.min(9999, q); else delete st.cart[key]; saveCart(); emit(); },
    addToCart(key, q) { key = String(key); this.setQty(key, (st.cart[key] || 0) + q); },
    toggleWish(id) {
      id = Number(id); const on = !st.wl[id];
      if (on) st.wl[id] = 1; else delete st.wl[id];
      if (st.user) call(on ? "PUT" : "DELETE", "/wishlist/" + id).catch(() => {}); else LS.set("ekb-wl", st.wl);
      emit();
    },

    addresses: () => call("GET", "/addresses").then((d) => d.addresses),
    addAddress: (a) => call("POST", "/addresses", a),
    updateAddress: (id, a) => call("PUT", "/addresses/" + id, a),
    deleteAddress: (id) => call("DELETE", "/addresses/" + id),

    async placeOrder(address, source) {
      const o = await call("POST", "/orders", { items: lines(), address, source });
      clearTimeout(pushT); st.cart = {}; emit();
      return o;
    },
    orders: () => call("GET", "/orders").then((d) => d.orders),
    order: (n) => call("GET", "/orders/" + encodeURIComponent(n)),
    cancelOrder: (n) => call("POST", "/orders/" + encodeURIComponent(n) + "/cancel"),
  };
})();
