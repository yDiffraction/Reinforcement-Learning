# Hopechess

A playable simultaneous-move chess variant. Plan in secret, reveal both orders together, and capture the opposing king.

## Play together on the same Wi-Fi

Use a current Node.js installation. There are no external dependencies and no install step.

```sh
npm start
```

Keep the terminal open. The host player can open [http://localhost:4173](http://localhost:4173). The terminal also prints a **Same Wi-Fi** address such as `http://192.168.1.25:4173`.

1. All players connect to the same Wi-Fi. Each other player opens the printed **Same Wi-Fi** address on their phone or computer.
2. One player selects **Multiplayer**, chooses **1v1 or 2v2** and **1, 3, 5, 10 minutes or No time limit**, leaves **Rated game** on (or switches it off for an unrated party), creates a room, and shares the four-digit room code or invite link.
3. The other players join that room, choosing White or Black for their team (or any open seat). Each player taps a piece and then a destination on their own device. The destination tap submits the move immediately; all moves reveal together.

If the second device cannot connect, allow incoming connections to Node.js in the host computer’s firewall. Guest Wi-Fi networks sometimes isolate devices; use a network that lets connected devices reach each other. A localhost link only opens the game on the host computer, so share the printed network address with your friend.

The server listens on all network interfaces by default. To choose another port, run `PORT=8080 npm start`. To listen only on this computer, run `HOST=127.0.0.1 npm start`. `npm run dev` starts the same server.

In 1v1, timed games give each player a total time allowance for the whole game, with no increment. Both clocks start when the second player joins. Making a move pauses that player's clock while the other player continues thinking. Both clocks resume immediately when the round is revealed, so time between moves counts; refreshing, disconnecting, or hiding the page does not pause a running clock. The first player to run out of time loses. If both clocks expire at exactly the same moment, the game is a draw. The server decides timeouts and keeps locked orders secret even if time runs out before a reveal. Rematches keep the selected time limit and refill both clocks. In 2v2, the time allowance is shared per team. Neither clock starts until all four seats are filled. A team clock pauses only after both teammates submit, and resumes when all four moves resolve. A timeout, resignation, or forfeit loses for the whole team.

```sh
npm test        # Run rules, multiplayer HTTP/SSE, and reconnect regression tests
npm run build   # Copy the static application into dist/
```

## Put it on a website later

Multiplayer needs the included Node.js server running on a host that supports long-lived HTTP connections (Server-Sent Events). Deploy this folder to a Node.js host and run `npm start`; the host can set `PORT` and `HOST` through environment variables. The server serves the application and room API from the same origin. If you add a reverse proxy, leave event streams unbuffered and allow connections to stay open; the server sends periodic keepalive pings.

The static `dist/` build supports computer and pass-and-play modes. Static hosting alone cannot run the multiplayer room server.

Rooms and games live in server memory. Restarting the server clears them; disconnected rooms expire after 24 hours without activity. Refreshing a browser keeps its seat and any locked order while that browser session is available. Explicitly leaving releases the seat. Leaving a rated game, or an unrated game after a move has been submitted, counts as a loss; a replacement player starts a fresh game. Invite links contain only the room code; player sessions stay in each browser tab’s sessionStorage. The app discovers the host’s network addresses to make a usable Wi-Fi invite even when the host opens localhost. Accounts and Elo ratings are stored locally on this host; there are no external dependencies.

## Accounts and Elo

Every new multiplayer party has **Rated game** switched on by default. Turn it off before creating the party to opt out; the choice applies to its rematches too. Guest games count just like signed-in games: creating or joining without an account automatically creates a saved guest profile. Each player has independent **1v1** and **2v2** ratings and records, both starting at **1,000 Elo**. Computer and pass & play remain local practice modes.

Use **Create account** from your guest profile to add a username and password while retaining both ratings and your results. Sign in to use the same profile on another device. A profile can occupy only one seat in a rated party; use different profiles for different players. An account stays attached to its seat until you leave the party.

A win, loss, or draw adjusts both ratings with standard Elo and a **K-factor of 32**. Equal-rated players gain/lose 16 points for a decisive result. Capturing a king, timeout, and resignation all count; leaving an active rated game is a loss. Refreshing or briefly disconnecting preserves your seat. Ratings update once per game, and the result popup shows every player’s rating change. In 2v2, expected results use each team’s average 2v2 Elo; both teammates receive the same change. For example, equal-rated teams each gain/lose 16 points per player for a decisive result. **Players** lists every named and guest profile with searchable usernames, both ratings, and separate game records. Select **1v1 Elo** or **2v2 Elo** to change the leaderboard and its sort order. Wins, losses, draws, timeouts, resignations, and active-party forfeits all count when Rated game is on. Unrated results change neither rating nor rated record.

Account data persists in `data/accounts.json`, which is excluded from Git and static builds. Passwords are salted and hashed. Browser sign-in sessions last 30 days and can be signed out. Back up this file to retain accounts and ratings; use `DATA_DIR=/path/to/data npm start` to choose another storage directory. Rooms and unfinished games are still cleared when the server stops. Existing accounts from the single-rating version retain that rating and its record under 1v1; their new 2v2 rating starts at 1,000. Passwords, existing sign-ins, and saved results are preserved during this migration.

The header’s **Leave party** button and the **Hopechess logo** both release your seat and return to the same multiplayer home screen. Leaving an active rated game counts as a loss; the home-screen message shows your Elo change. A normal refresh after leaving stays home instead of rejoining the old party.

To stop the server, press **Ctrl+C** in its terminal. Start it again with `npm start` from this folder.

## Playing

Select a piece and tap a highlighted destination to make your move immediately in computer and multiplayer games. All orders resolve together, and the next round starts automatically. In pass & play, the destination remains a draft until you confirm with **Lock in move**, keeping the handoff private.

- **Vs Computer:** Play White, Black, or a randomly assigned color. Normal compares possible simultaneous replies; Easy chooses random legal moves. The computer commits before you choose your move.
- **Pass & play:** Two people share a device. A handoff screen hides the first order while the other player plans. The player who plans first alternates each round.
- **Multiplayer 1v1:** Two people use separate devices and a shared room. The server validates moves and keeps opposing orders secret until both players have moved. Room codes contain exactly four digits, including leading zeroes. Disconnections retain seats so refreshing can reconnect. Both players must agree to a rematch.
- **Multiplayer 2v2:** Four people share the standard board: two control White, two control Black. Each teammate submits one move; all four resolve at once. The roster shows who is ready. See the team conflict rules below. All four players must accept a rematch.
- **Watch:** Use the header’s **Watch** button to browse every current room or enter a four-digit party code. Watch links open separate tabs without interrupting your own game. You can also use **Watch this code** in the multiplayer lobby. Spectators do not take a player seat, cannot move, resign, or vote on rematches, and never receive pending orders. They see the live board, clocks, player readiness, results, and completed round history. A `?watch=0123` link opens a spectator view directly; refreshing reconnects to it.

The board shows when you can move and marks pieces with available moves. Your submitted move appears as a grey preview while waiting. In 2v2, your teammate can see it too, so you can coordinate. Opponents and spectators cannot. Use **Preview on/off** beside the board to hide or show these previews; the choice is remembered in that browser. It changes only the visuals and never cancels a submitted move. Reservations remain enforced when previews are hidden. The interface also includes promotion choices, captured pieces, round history, board rotation, optional sound, keyboard board navigation, and a result popup.

## Rules

- Each player submits one legal move using the board at the start of the round. Standard movement and blocking apply; kings may move into danger. There is no check or checkmate. A king may target the opposing king only when that king is resting after a capture in the immediately previous round.
- When both moving pieces land on the same square, the weaker captures the stronger. Strength is **pawn < knight < bishop < rook < queen < king**. A pawn moving forward can win this collision. Equal types capture each other and both disappear, except two active kings: if they meet on an empty square, both return to their starting squares without capturing. They still count as having moved. In 2v2, another enemy piece arriving at a returning king’s starting square can capture it.
- An ordinary capture against a stationary enemy follows standard chess capture rules, regardless of strength. A moving target escapes, including when two pieces swap squares or cross paths.
- A surviving piece that captures must rest for the entire next round. It remains on the board and may be captured. A move aimed at an escaping target does not cause rest.
- Apart from en passant, a pawn may move diagonally only when an enemy occupies the destination at the start of the round. If that enemy moves away, the pawn still completes its diagonal move. Forward destinations and double-step paths must initially be empty. A pawn may advance two squares from its starting rank.
- Pawns promote to a queen, rook, bishop, or knight on the last rank. Choose the promotion before submitting the order. It takes effect on arrival, before captures or collisions: a pawn promoting to a queen collides at queen strength, and a knight promotion collides at knight strength. The chosen promoted piece is recorded if captured. Promotion is still a pawn move for the no-progress counter.
- Capture the opposing king to win. If both kings are captured in the same round, the game is a draw.
- **Castling:** Move the king two squares toward a rook. Neither king nor rook may have moved or be resting, and all squares between them must be empty. You may castle into, through, or out of attack. Both pieces depart simultaneously; their destinations resolve independently under the collision rules. If one is captured, the other still completes its move. Only a piece that captures must rest.
- **En passant:** In the round immediately after an enemy pawn survives a two-square advance, an adjacent pawn may move diagonally behind it. If that enemy pawn moves again, it escapes, and the diagonal move still happens. The capturing pawn must survive any collision at its destination to remove the target; a successful capture causes rest.
- A player with no legal move passes automatically in computer and multiplayer games; pass & play provides **Lock in pass**. If both players lack moves, their passes clear temporary rests. The game draws only if neither player can move after that recovery.
- A position occurring three times is a draw; the position includes resting pieces, castling rights, and en passant rights. The game also draws after 100 rounds without a pawn move or capture. Standard insufficient-material draws do not apply.

## 2v2 conflict rules

- Each teammate moves a different piece, with a different destination. The first order accepted by the server reserves that piece and square for the round. A conflicting later order is rejected so that player can choose again. The interface updates reservations immediately; a server race cannot move the same piece twice.
- Castling is one player’s order and reserves both king and rook, plus both destinations. The other teammate must move a different piece to another square.
- All move legality and path blockers use the board at the start of the round. You cannot move onto a friendly occupied square even if your teammate is moving that piece. Paths may cross, as in 1v1.
- With friendly destinations kept distinct, at most one piece from each team arrives at any square. Enemy collisions use the usual weaker-wins rule, independently on every square. Captures, rest, promotion, castling, and en passant work for each moving piece independently.
- If no distinct legal move remains after a teammate’s reservation, the other player passes automatically. Passing is otherwise forbidden. Having only one movable piece never requires moving it twice.
- All four orders resolve before deciding whether a king was captured. Capturing the opposing king wins for both teammates; both kings captured means a draw. Leaving after play begins or resigning forfeits for the whole team.
- Pending orders are shared only within a team. Spectators and opponents see readiness, never the moves themselves before the reveal.

## Implementation

- `engine.js`: Immutable game state, legal moves, simultaneous resolution for one or two orders per side, team reservation checks, draw detection, and computer move selection. A board is a 64-entry array; orders use `{ from, to, promotion? }`.
- `engine.test.js`: Node tests for collisions, captures, evasion, rest, promotion, castling, en passant, king outcomes, forced passes, draws, and computer move legality and safety, including king protection and promoted collision strength.
- `accounts.mjs`, `accounts.test.js`: Persistent accounts, password hashing, public search, Elo, and result deduplication tests.
- `app.js`, `index.html`, and `styles.css`: Browser interface, secret order flow, accessibility, and responsive layout.
- `multiplayer.js`: Room API client, live state events, and browser session reconnection.
- `pieces.js`: Inline SVG chess pieces and icons.
- `server.mjs`: Authoritative multiplayer rooms, move validation, live events, and application serving using Node built-ins.
- `multiplayer-server.test.js`: End-to-end HTTP and live event tests for two/four players, private team orders, team clocks, live spectators, public room browsing, reconnects, rematches, and membership.
- `multiplayer-client.test.js`: Regression tests for failed-leave recovery and out-of-order live/HTTP updates.
- `build.mjs`: Static application build using Node built-ins.

Computer and pass-and-play games save in the browser's local storage. Multiplayer boards live on the server and sync between players and spectators; each browser tab keeps its player session for reconnecting after refresh. Saves and sessions belong to that browser and site origin; clearing browser data, private browsing, or storage restrictions may erase or prevent them. Starting a new local game replaces its saved game.
