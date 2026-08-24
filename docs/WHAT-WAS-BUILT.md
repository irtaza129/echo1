# What was built

Turning the voice kiosk into a full restaurant POS. Six phases. Nothing is committed yet.

---

## The one big idea

Before: voice orders went into Redis, POS orders went into Postgres, and nothing
reconciled them. You could not answer "what did we sell today" or "is the till
correct".

Now: **every channel writes to one order ledger** in Postgres, tagged with where it
came from (`till`, `kiosk`, `phone`, `WhatsApp`, `table QR`). Everything else in this
document depends on that.

---

## Modules

### 1. The Till (cashier screen)

**Who:** cashier, manager.
**Where:** log in → sidebar → **Till →** → enter PIN.

Ring up walk-ins, take money (cash, card, split across both), open and close the
cash drawer, void and discount with a manager's PIN, see every table's open tab.

**Useful because** the kiosk could take orders but not money. This is what makes the
system a POS instead of an order-taking app — it answers "is the drawer correct at
11pm", which nothing before it could.

**Set it up:** Till → **Setup** → **Staff & PINs**. Give each person a PIN
(**Suggest** picks a safe one) and tick what they may do. PIN `4817` is already set
on the `fassih` tenant with **no permissions**, so void and discount correctly refuse
until you tick them.

---

### 2. Live orders (everywhere)

**Who:** everyone on staff.
**Where:** automatic.

Orders used to appear on a 60-second refresh. Now they arrive in under a second,
from any channel.

**Useful because** a cashier learning about table 7 a minute late is a cashier
apologising. The green **Live** badge on the till header tells staff the difference
between "no new orders" and "not receiving orders" — only one of those is normal.

---

### 3. Kitchen display

**Who:** cooks, expo.
**Where:** Till → **Kitchen** tab.

Tickets sorted oldest first, colour by age (amber at 5 min, red at 10). Tap a line
when it is ready. Stations (grill / fryer / drinks) can each see only their own work.

**Useful because** you tap **one line**, not the whole order — the drinks are ready
long before the karahi. When the last line is tapped, the order automatically becomes
"ready" and the front counter and the customer's phone both find out. Tapped
something by mistake? **Recall** puts it back; without that the only fix is
re-ringing the item, which charges the customer twice for a kitchen error.

---

### 4. Table QR ordering

**Who:** diners, on their own phones.
**Where:** scan the QR on the table, type the printed PIN.

They see the menu, **hold a button and speak their order**, watch it cook, and can
press **Call Waiter** — which pops on the cashier's screen saying "Table 6", with a
timer, going red after three minutes.

**Useful because** it is the whole product on a phone the customer already owns — no
hardware per table. Four people at one table share **one basket and one bill**, which
is how groups actually order.

**Why a QR *and* a PIN:** the QR alone can be photographed and used from the car park.
The PIN is printed beside it, never inside it, and can be changed without reprinting.

**Set it up:** Till → **Setup** → **Tables & QR**. Add tables (type `1-12` for a
range), press **Create code**, and the QR and PIN appear on screen. **Print visible
cards** opens a print sheet, one A6 card per table. **Open as a guest ↗** shows you
exactly what the diner sees.

---

### 5. Phone agent

**Who:** anyone ringing the restaurant.

Answers, greets, and asks first: *"Is this for delivery, pick-up or take-away — or did
you have a question about dining in?"* Then either takes the order (demanding a full
address for delivery) or answers the question without forcing it into an order.

**Useful because** nobody has to sit by the phone during service.

⚠️ **Not working yet.** The code is written and tested, but it has never handled a
real call — it needs an Asterisk server, a SIP trunk and a static IP. See "What's
left" below.

---

### 6. Bookings and waitlist

**Who:** host, manager.
**Where:** Till → **Bookings** tab (only appears if the module is switched on).

Take bookings, seat them onto a table, mark no-shows, and hold walk-ins on a waitlist
that goes red when they pass their quoted wait.

**Useful because** the backend for this already existed and was simply unreachable —
this makes it usable.

---

### 7. Reports

**Who:** owner, manager.
**Where:** Till → **Reports** tab.

Sales, average order, busiest hour, best sellers, how people paid, and **where orders
came from**. Export to CSV.

**Useful because** the channel breakdown is the number that tells you whether the
kiosk, the phone and the QR codes are actually earning their keep, or whether
everything still comes through the till.

---

### 8. Receipts and kitchen tickets

Prints to a normal thermal printer over the network, or hands the file to the browser
if no printer is set up.

**Useful because** a kitchen ticket is not a receipt with the prices removed — the
order number is double height, quantities lead every line, and money never appears,
because it is not something a cook can act on. Reprints say **REPRINT** in large
letters so nothing gets cooked twice.

---

## Things fixed along the way

- **`/api/orders` was readable by anyone** who knew a tenant ID — every customer name,
  phone number and total. Now requires a login.
- **A password was hardcoded in the source.** Anyone could sign in as an admin where
  one setting was left unset. Now disabled unless deliberately configured.
- **Every order write would have failed** the first time it ran, for two schema
  reasons nobody could have known without checking the live database.
- Deleted a leftover file that returned the **Google API key** to anyone who asked.
- Rewrote `CLAUDE.md`, which still described the old single-restaurant kiosk.

---

## What is left

**Needs hardware or an account — code is done:**

| Thing | What it needs |
|---|---|
| Phone agent | Asterisk server + Pakistani SIP trunk + static IP. **Insist on G.711** — the common G.729 gives a connected call with total silence. Setup guide: `telephony/sip/README-asterisk.md` |
| Receipt printing | A network thermal printer's IP address in the tenant's settings |

**Not built yet:**

| Thing | Why it matters |
|---|---|
| **FBR / PRA e-invoicing** | **Legally required** for Pakistani restaurants. Designed but not written — needs real FBR credentials to be worth building |
| Safepay card payments | Fully written but never connected. Until it is, Pakistani tenants are cash-only for cards (Paddle does not accept PKR) |
| Inventory / stock | Not started |
| Multiple branches | Column exists in the database, nothing uses it |

**Known weak spots:**

- Account passwords still use a weak hash (till PINs are done properly).
- 14 older database tables have no row-level security policies. Harmless today
  because of how the app connects, but it should be tidied.
- Nothing has been committed to git yet.

---

## Trying it

```bash
npm run dev          # then log in, sidebar → "Till →" → PIN 4817
npm test             # 196 checks, no database needed
npm run lint
```

Live checks (each cleans up after itself):

```bash
npm run test:live    -- --tenant <uuid>   # till: order → split payment → report
npm run test:guest   -- --slug fassih     # QR: scan → PIN → call waiter → voice
npm run test:kds     -- --tenant <uuid>   # kitchen: bump → ready → recall
npm run test:reports -- --tenant <uuid>
npm run test:setup   -- --tenant <uuid>   # setup screens: tables, QR, PINs, permissions
```

Everything else is now in the app:

| I want to… | Go to |
|---|---|
| Turn the till, table ordering, bookings or phone on/off | Till → **Setup** → What you use |
| Add tables and print their QR cards | Till → **Setup** → Tables & QR |
| Give someone a PIN, or decide what they may do | Till → **Setup** → Staff & PINs |
| See what a diner sees | Tables & QR → **Open as a guest ↗** |

**Setup** only appears for account admins — a cashier cannot switch the till off
mid-service or grant themselves the void permission.
