"use client";

interface App {
  id: string;
  name: string;
}

interface AppFilterSelectProps {
  apps: App[];
  selectedAppId: string | null;
}

export default function AppFilterSelect({ apps, selectedAppId }: AppFilterSelectProps) {
  return (
    <form method="GET">
      <select
        name="app"
        defaultValue={selectedAppId ?? ""}
        onChange={(e) => {
          (e.currentTarget.form as HTMLFormElement).submit();
        }}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300"
      >
        <option value="">All apps</option>
        {apps.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="ml-2 text-xs underline">
          Filter
        </button>
      </noscript>
    </form>
  );
}
