# Security Specification — PAI Nusantara 3D Firestore Rules

## 1. Data Invariants
1. **Master Gate & Room Isolation**: All subcollection documents (`/participants/{participantId}`, `/messages/{messageId}`, `/alerts/{alertId}`) MUST belong to an existing parent room `/rooms/{roomCode}` and enforce `incoming().roomCode == roomCode`.
2. **ID Poisoning Guard**: Every single-document operation (`get`, `create`, `update`, `delete`) validates document IDs via `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 80 chars) and room codes via `isValidRoomCode()` (`^[A-Z0-9\-]+$`, 3–12 chars).
3. **Zero PII Storage**: No emails, phone numbers, addresses, or passwords are stored in Firestore; only student display nickname (`nama`), grade (`kelas`), school name (`sekolah`), avatar choices, and educational quiz metrics.
4. **Strict Schema & Volumetric Bounds**: Every string has `.size()` caps, every list has `.size() <= MAX` caps (`mutedParticipantIds <= 100`, `answeredLog <= 200`, `options <= 6`), and every `create` uses `keys().hasAll(...) && keys().hasOnly(...)` while every `update` uses `affectedKeys().hasOnly(...)` inside an action-based gate wrapped by `isValid[Entity]()`.
5. **Immutable Identity Fields**: `id`, `roomCode`, `joinedAt` (participants), `createdAt` (messages/alerts/testimonials) cannot be mutated on update.
6. **Teacher-Only Moderation & Mission Authority**: Only teacher writes passing `isTeacherWrite()` (verified admin email OR valid `adminKey == 'gpaibeji'` stripped/checked) can pin/delete chat messages, toggle room mute, change mission config/leaderboardParams, or approve students. Wait: never store plain secrets in documents — verify `isTeacherAuth()` OR check room-level classroom access cleanly without exposing admin secrets in readable docs!

## 2. "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Shadow Field Injection on Participant Create**: `{ id: "stu_1", roomCode: "PAI2026", ..., isAdmin: true }` -> denied by `keys().hasOnly(...)`.
2. **Oversized ID Poisoning**: Document path `/rooms/PAI2026/participants/${"a".repeat(200)}` -> denied by `isValidId(participantId)`.
3. **Orphaned Participant Without Parent Room**: Create `/rooms/GHOST99/participants/stu_1` when `/rooms/GHOST99` does not exist -> denied by `exists(/databases/$(database)/documents/rooms/$(roomCode))`.
4. **Cross-Room Code Mismatch**: Create `/rooms/PAI2026/messages/msg_1` with `roomCode: "OTHER99"` -> denied by `incoming().roomCode == roomCode`.
5. **Oversized Chat Payload (Denial of Wallet)**: Message `text` length > 280 chars -> denied by `data.text.size() <= 280`.
6. **Unbounded Array Injection**: `answeredLog` with > 200 entries or `mutedParticipantIds` with > 100 entries -> denied by `.size()` cap.
7. **Invalid Enum Value**: Participant `activity: "hacked"` or `level: "godmode"` -> denied by allowlist check.
8. **Immutable Field Mutation**: Updating participant `joinedAt` or `id` -> denied by immutability check.
9. **Unauthorized Chat Message Deletion / Tampering**: Updating a chat message's `text` or `senderRole` after creation -> denied by `affectedKeys().hasOnly(['pinned', 'deleted'])`.
10. **Invalid Leaderboard Parameter Range**: Setting `speedWeight: 999` or `wrongPenalty: -50` -> denied by numeric range validation (`0..100`, `0..50`).
11. **Oversized Alert Detail**: Alert `detail` > 280 chars or unknown `kind` -> denied by `isValidAlert()`.
12. **Catch-All Unlisted Collection Write**: Writing to `/secretCollection/doc1` -> denied by default-deny catch-all `match /{document=**} { allow read, write: if false; }`.
