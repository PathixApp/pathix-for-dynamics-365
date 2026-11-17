// The line a card shows for a field inside a quick view: another record's
// form, shown read-only on this one. The card is about the quick
// view's own table and column, so it says where the field comes from and why
// this form cannot change it. The same line in Lite and connected mode: it
// counts nothing and claims no writers.

export function quickViewLine(table: string): string {
  return `A quick view shows this ${table} column from the related record, read-only. Open the ${table} to edit it.`;
}
