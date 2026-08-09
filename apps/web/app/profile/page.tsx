'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchMe, type AuthUser } from '@/lib/api';
import { Sidebar } from '@/components/profile/Sidebar';
import { MobileTabs } from '@/components/profile/MobileTabs';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { AccountSection } from '@/components/profile/AccountSection';
import { PreferencesSection } from '@/components/profile/PreferencesSection';
import { PrivacySection } from '@/components/profile/PrivacySection';
import { SessionsSection } from '@/components/profile/SessionsSection';
import { AdminSection } from '@/components/profile/AdminSection';

export default function ProfilePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setLoading(false);
      if (!u) router.replace('/login');
    });
  }, [router]);

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-10">
        <div className="animate-pulse space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-10 w-64 rounded-lg bg-card" />
          ))}
        </div>
      </main>
    );
  }

  if (!user) return null;

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 sm:py-10">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-2xl font-semibold text-primary">Profile</h1>
      </div>

      <MobileTabs />

      <div className="flex gap-8">
        <Sidebar isAdmin={user.role === 'admin'} />

        <div className="flex-1 min-w-0">
          <ProfileSection user={user} onUpdate={setUser} />
          <AccountSection user={user} />
          <PreferencesSection user={user} onUpdate={setUser} />
          <PrivacySection />
          <SessionsSection />
          {user.role === 'admin' && <AdminSection />}
        </div>
      </div>
    </main>
  );
}
