'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { Settings, NewsSource } from '@/types'

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sources, setSources] = useState<NewsSource[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/settings').then(r => r.json()),
      fetch('/api/news/sources').then(r => r.json()).catch(() => ({ sources: [] })),
    ]).then(([s, src]) => {
      setSettings(s as Settings)
      setSources((src as { sources: NewsSource[] }).sources ?? [])
    })
  }, [])

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const updated = await res.json() as Settings
      setSettings(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  async function toggleSource(id: string, isActive: boolean) {
    await fetch(`/api/news/sources/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: isActive ? 1 : 0 }),
    })
    setSources(prev => prev.map(s => s.id === id ? { ...s, isActive: isActive ? 1 : 0 } : s))
  }

  async function updateWeight(id: string, weight: number) {
    await fetch(`/api/news/sources/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight }),
    })
    setSources(prev => prev.map(s => s.id === id ? { ...s, weight } : s))
  }

  if (!settings) return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">← Dashboard</a>
      </div>

      {/* Thresholds */}
      <Card>
        <CardHeader><CardTitle className="text-base">Generation Thresholds</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Auto-generate score threshold: <strong>{settings.autoGenerateThreshold}</strong></Label>
            <Slider
              min={1} max={10} step={0.5}
              value={[settings.autoGenerateThreshold ?? 6.5]}
              onValueChange={(vals) => setSettings(s => s ? { ...s, autoGenerateThreshold: Array.isArray(vals) ? vals[0] : vals } : s)}
              onValueCommitted={(vals) => saveSettings({ autoGenerateThreshold: Array.isArray(vals) ? vals[0] : vals })}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">Clusters scoring above this get posts generated automatically.</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Daily post limit: <strong>{settings.dailyPostLimit}</strong></Label>
            <Slider
              min={1} max={100} step={1}
              value={[settings.dailyPostLimit ?? 20]}
              onValueChange={(vals) => setSettings(s => s ? { ...s, dailyPostLimit: Array.isArray(vals) ? vals[0] : vals } : s)}
              onValueCommitted={(vals) => saveSettings({ dailyPostLimit: Array.isArray(vals) ? vals[0] : vals })}
              className="w-full"
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Post cooldown (minutes): <strong>{settings.postCooldownMinutes}</strong></Label>
            <Slider
              min={1} max={120} step={1}
              value={[settings.postCooldownMinutes ?? 15]}
              onValueChange={(vals) => setSettings(s => s ? { ...s, postCooldownMinutes: Array.isArray(vals) ? vals[0] : vals } : s)}
              onValueCommitted={(vals) => saveSettings({ postCooldownMinutes: Array.isArray(vals) ? vals[0] : vals })}
              className="w-full"
            />
          </div>
        </CardContent>
      </Card>

      {/* Lark */}
      <Card>
        <CardHeader><CardTitle className="text-base">Lark Integration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Lark notifications</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Send posts to Lark group for review</p>
            </div>
            <Switch
              checked={settings.larkEnabled === 1}
              onCheckedChange={v => saveSettings({ larkEnabled: v ? 1 : 0 })}
            />
          </div>
        </CardContent>
      </Card>

      {/* News Sources */}
      <Card>
        <CardHeader><CardTitle className="text-base">News Sources</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {sources.length === 0 && <p className="text-sm text-muted-foreground">Loading sources…</p>}
          {sources.map(source => (
            <div key={source.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium">{source.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{source.category}</span>
                </div>
                <Switch
                  checked={source.isActive === 1}
                  onCheckedChange={v => toggleSource(source.id, v)}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-16">Weight: {source.weight}</span>
                <Slider
                  min={1} max={10} step={1}
                  value={[source.weight ?? 5]}
                  onValueChange={(vals) => setSources(prev => prev.map(s => s.id === source.id ? { ...s, weight: Array.isArray(vals) ? vals[0] : vals } : s))}
                  onValueCommitted={(vals) => updateWeight(source.id, Array.isArray(vals) ? vals[0] : vals)}
                  className="flex-1"
                />
              </div>
              <Separator />
            </div>
          ))}
        </CardContent>
      </Card>

      {saving && <p className="text-xs text-muted-foreground text-right">Saving…</p>}
      {saved && <p className="text-xs text-green-600 text-right">Saved.</p>}
    </div>
  )
}
