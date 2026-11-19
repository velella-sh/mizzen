export default function doc({ page }: { readonly page: { readonly title: string; readonly html: string } }): string {
  return `<!DOCTYPE html>\n<html lang="en" dir="ltr"><head><title>${page.title}</title></head><body>\n${page.html}\n</body></html>\n`;
}
