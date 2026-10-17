import { customType } from "drizzle-orm/pg-core";

/** Case-insensitive text (requires the `citext` extension). Used for emails. */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});
