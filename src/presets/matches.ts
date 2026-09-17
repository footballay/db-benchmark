/** 실제 PK 대신 팀 내 논리 슬롯을 사용하는 경기 스냅샷이다. */
export interface Event { minute: number; type: string; detail: string; side: number; player: number; assist: number | null }
export interface MatchPreset { name: string; score: [number, number]; events: Event[] }
const scores: [number, number][] = [[0, 0], [1, 0], [2, 1], [3, 2], [1, 1]];
export const matches: MatchPreset[] = scores.map((score, p) => {
  const events: Event[] = [];
  for (let side = 0; side < 2; side++) for (let sub = 0; sub < 3; sub++)
    events.push({ minute: 60 + sub * 10, type: 'Subst', detail: 'Substitution', side, player: 11 + sub, assist: 8 + sub });
  for (let side = 0; side < 2; side++) for (let goal = 0; goal < score[side]; goal++)
    events.push({ minute: 15 + goal * 15 + side * 3, type: 'Goal', detail: 'Normal Goal', side, player: 8 + goal % 3, assist: 5 });
  const cards = p === 3 ? 5 : p === 4 ? 3 : 2;
  for (let i = 0; i < cards; i++) events.push({ minute: 25 + i * 8, type: 'Card', detail: 'Yellow Card', side: i % 2, player: 1 + Math.floor(i / 2), assist: null });
  if (p === 4) events.push({ minute: 85, type: 'Card', detail: 'Red Card', side: 1, player: 4, assist: null });
  events.sort((a, b) => a.minute - b.minute || a.side - b.side);
  return { name: String.fromCharCode(65 + p), score, events };
});
export const slots = ['GK', 'CB1', 'CB2', 'LB', 'RB', 'CM1', 'CM2', 'AM', 'FW1', 'FW2', 'FW3', 'SUB1', 'SUB2', 'SUB3', 'SUB4', 'SUB5', 'SUB6', 'SUB7'];
