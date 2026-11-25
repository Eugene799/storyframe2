import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const supabaseKey =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim() ?? "";

interface BrowserClientResult {
  client: SupabaseClient | null;
  /** Set only when the variables are present but unusable, so the UI can name the problem. */
  configError: string | null;
}

function createBrowserClient(): BrowserClientResult {
  if (!supabaseUrl && !supabaseKey) return { client: null, configError: null };
  if (!supabaseUrl) {
    return { client: null, configError: "VITE_SUPABASE_URL is not set, but a publishable key is." };
  }
  if (!supabaseKey) {
    return { client: null, configError: "VITE_SUPABASE_PUBLISHABLE_KEY is not set, but a project URL is." };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    return { client: null, configError: "VITE_SUPABASE_URL is not a valid URL." };
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return { client: null, configError: "VITE_SUPABASE_URL must be an http or https URL." };
  }

  try {
    return {
      // The client refreshes the session on its own (autoRefreshToken) and
      // single-flights concurrent refreshes; session tokens stay in storage and
      // are only sent to the StoryFrame server in the Authorization header.
      client: createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      }),
      configError: null,
    };
  } catch {
    return {
      client: null,
      configError:
        "The browser Supabase client could not be created from VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.",
    };
  }
}

const browserClient = createBrowserClient();

/** Null when the browser-safe Supabase URL or publishable key is missing or unusable. */
export const supabase = browserClient.client;

/** Why `supabase` is null when the browser auth variables are present but wrong. */
export const supabaseConfigError = browserClient.configError;
