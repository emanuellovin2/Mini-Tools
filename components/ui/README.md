# UI Primitives

All primitives live in `components/ui/` and are exported from `components/ui/index.ts`. Import from there or directly from the file.

## Button
Variants: `default` (primary), `secondary`, `destructive`, `ghost`, `link`. Sizes: `sm`, `md` (default), `lg`, `icon`.
```tsx
<Button variant="destructive" size="sm" onClick={handler}>Delete</Button>
```

## Card
Composable card container with optional sub-parts.
```tsx
<Card><CardHeader><CardTitle>Title</CardTitle><CardDescription>desc</CardDescription></CardHeader><CardContent>…</CardContent></Card>
```

## Input / Select / Label
Standard form controls styled to match the token system.
```tsx
<Label htmlFor="slug">Slug</Label>
<Input id="slug" name="slug" placeholder="my-store" />
<Select name="status"><option value="active">Active</option></Select>
```

## Badge
Variants: `default`, `secondary` (default), `success`, `warning`, `destructive`.
```tsx
<Badge variant="success">Active</Badge>
```

## Modal
`<dialog>`-based accessible confirm dialog. Pass `open`, `onClose`, `onConfirm`, and optional `confirmVariant="destructive"`.
```tsx
<Modal open={open} onClose={() => setOpen(false)} title="Sure?" onConfirm={doIt} confirmLabel="Yes" confirmVariant="destructive" />
```

## Toast
Wrap your layout in `<ToastProvider>`. Call `useToast()` in any client component to get a `toast(message, type?)` function. Types: `"success"`, `"error"`, `"default"`.
```tsx
const toast = useToast();
toast("Saved!", "success");
```

## Table
```tsx
<Table><TableHead><TableRow><TableHeadCell>Name</TableHeadCell></TableRow></TableHead>
<TableBody><TableRow><TableCell>value</TableCell></TableRow></TableBody></Table>
```

## Skeleton
Pulse-loading placeholder. Set width/height via className.
```tsx
<Skeleton className="h-4 w-32" />
```

## cn
Small class-name merge utility (no deps).
```ts
cn("base", condition && "extra", undefined) // → "base extra"
```
