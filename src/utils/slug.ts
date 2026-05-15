export function sanitizeToSlug(value: string): string {
	return value.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
