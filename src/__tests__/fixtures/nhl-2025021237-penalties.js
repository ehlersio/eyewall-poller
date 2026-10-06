// src/__tests__/fixtures/nhl-2025021237-penalties.js
// Real data: every penalty play in game 2025021237 (BOS @ CAR, 2026-04-07),
// in feed order, from api-web.nhle.com/v1/gamecenter/2025021237/play-by-play
// -- coordinates dropped -- plus the rosterSpots they name. The first is a
// bench minor for a failed coach's challenge: no committedByPlayerId, only
// servedByPlayerId (Taylor Hall).

export const game = {
  id: 2025021237, gameType: 2,
  homeTeam: { id: 12, abbrev: 'CAR' },
  awayTeam: { id: 6, abbrev: 'BOS' },
}

export const penaltyPlays = [
  { eventId: 379, periodDescriptor: { number: 1, periodType: 'REG' }, timeInPeriod: '17:25', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'BEN', descKey: 'delaying-game-unsuccessful-challenge', duration: 2, servedByPlayerId: 8475791, eventOwnerTeamId: 12 } },
  { eventId: 31, periodDescriptor: { number: 1, periodType: 'REG' }, timeInPeriod: '20:00', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'MIN', descKey: 'interference-goalkeeper', duration: 2, committedByPlayerId: 8480355, drawnByPlayerId: 8483548, eventOwnerTeamId: 6 } },
  { eventId: 510, periodDescriptor: { number: 2, periodType: 'REG' }, timeInPeriod: '04:23', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'MIN', descKey: 'slashing', duration: 2, committedByPlayerId: 8477507, drawnByPlayerId: 8475791, eventOwnerTeamId: 6 } },
  { eventId: 755, periodDescriptor: { number: 2, periodType: 'REG' }, timeInPeriod: '19:22', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'MIN', descKey: 'cross-checking', duration: 2, committedByPlayerId: 8479325, drawnByPlayerId: 8480830, eventOwnerTeamId: 6 } },
  { eventId: 842, periodDescriptor: { number: 3, periodType: 'REG' }, timeInPeriod: '04:57', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'MIN', descKey: 'high-sticking', duration: 2, committedByPlayerId: 8477956, drawnByPlayerId: 8477940, eventOwnerTeamId: 6 } },
  { eventId: 1057, periodDescriptor: { number: 3, periodType: 'REG' }, timeInPeriod: '16:44', situationCode: '1551', typeDescKey: 'penalty',
    details: { typeCode: 'MIN', descKey: 'interference', duration: 2, committedByPlayerId: 8476921, drawnByPlayerId: 8481219, eventOwnerTeamId: 12 } },
]

export const rosterSpots = [
  { teamId: 12, playerId: 8475791, firstName: { default: 'Taylor' }, lastName: { default: 'Hall' } },
  { teamId: 12, playerId: 8476921, firstName: { default: 'Jordan' }, lastName: { default: 'Martinook' } },
  { teamId: 6, playerId: 8477507, firstName: { default: 'Nikita' }, lastName: { default: 'Zadorov' } },
  { teamId: 6, playerId: 8477956, firstName: { default: 'David' }, lastName: { default: 'Pastrnak' } },
  { teamId: 6, playerId: 8479325, firstName: { default: 'Charlie' }, lastName: { default: 'McAvoy' } },
  { teamId: 6, playerId: 8480355, firstName: { default: 'Mark' }, lastName: { default: 'Kastelic' } },
]
