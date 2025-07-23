import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Shield, Copy, CheckCircle, ArrowLeft, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SessionReady = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionInfo, setSessionInfo] = useState<any>(null);

  useEffect(() => {
    const fetchSession = async () => {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
      }
    };
    fetchSession();
  }, [sessionId]);

  const copyLink = async () => {
    if (sessionInfo?.link) {
      await navigator.clipboard.writeText(sessionInfo.link);
    }
  };

  if (!sessionInfo) {
    return <div className="text-center py-12">Loading session info...</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/')}
                className="mr-2"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-900">PSI Secure</h1>
            </div>
            <div className="text-sm text-gray-600">Session Ready</div>
          </div>
        </div>
      </header>
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Session Ready!
              </h2>
              <p className="text-lg text-gray-600">
                Share the link below with the other party to begin the PSI
                process
              </p>
            </div>
            <div className="space-y-6">
              <Card className="shadow-lg">
                <CardHeader>
                  <CardTitle>Session Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        Session Name
                      </Label>
                      <p className="text-lg font-medium text-gray-900">
                        {sessionInfo.sessionName}
                      </p>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        Session ID
                      </Label>
                      <p className="text-sm font-mono text-gray-700 bg-gray-100 px-3 py-2 rounded">
                        {sessionId}
                      </p>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        File Uploaded
                      </Label>
                      <p className="text-sm text-gray-700">
                        (Uploaded by creator)
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-lg border-blue-200">
                <CardHeader>
                  <CardTitle className="text-blue-900">
                    Shareable Link
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-3">
                    <Input
                      value={sessionInfo.link || ''}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button onClick={copyLink} variant="outline">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-sm text-gray-600 mt-2">
                    Send this link to the other party. They'll use it to join
                    your session.
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-orange-50 border-orange-200">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-3">
                    <Clock className="w-5 h-5 text-orange-600" />
                    <div>
                      <p className="font-medium text-orange-900">
                        Waiting for other party
                      </p>
                      <p className="text-sm text-orange-700">
                        Once they join and upload their file, you'll be able to
                        proceed with the intersection.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionReady;
