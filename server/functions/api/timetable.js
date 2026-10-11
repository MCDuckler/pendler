import { jsonResponse } from './_shared.js';
import { fetchTimetableEvents, getEventsForWeek, getMonday } from './_timetable.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const timetableUrl = url.searchParams.get('url');
  if (!timetableUrl) return jsonResponse({ error: 'url required' }, 400);

  // week param: YYYY-MM-DD of any day in the target week (matches the client)
  const weekStr = url.searchParams.get('week');
  const monday = weekStr ? getMonday(new Date(weekStr)) : getMonday(new Date());

  try {
    const events = await fetchTimetableEvents(timetableUrl);
    const days = getEventsForWeek(events, monday);
    const pad2 = n => String(n).padStart(2, '0');
    const weekDate = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
    return jsonResponse({ week: weekDate, days });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}
