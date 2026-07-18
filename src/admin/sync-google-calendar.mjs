import { syncGoogleCalendar } from "../integrations/google-calendar.mjs";

console.log(JSON.stringify(await syncGoogleCalendar(), null, 2));
