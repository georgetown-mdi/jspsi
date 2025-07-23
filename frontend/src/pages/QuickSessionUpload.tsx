import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import FileUpload from '@/components/FileUpload';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { Shield, Users, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const QuickSessionUpload = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionInfo, setSessionInfo] = useState(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    // Fetch session info from backend
    const fetchSession = async () => {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
      }
    };
    fetchSession();
  }, [sessionId]);

  const handleSubmit = async () => {
    // ...your CSV upload logic...
    navigate(`/session/${sessionId}/ready`);
  };

  return (
    <div className="min-h-screen bg-blue-50">
      {/* Header */}
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
            <div className="text-sm text-gray-600"></div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Upload Your CSV
              </h2>
              <p className="text-lg text-gray-600">
                Upload your dataset for this session. You can review the session
                details below.
              </p>
            </div>

            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Users className="w-5 h-5 mr-2 text-blue-600" />
                  Session Setup
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {sessionInfo ? (
                  <div>
                    <div className="mb-2">
                      <span className="font-semibold">Session Name:</span>{' '}
                      {sessionInfo.sessionName}
                    </div>
                    <div className="mb-2">
                      <span className="font-semibold">Your Name:</span>{' '}
                      {sessionInfo.initiatedName}
                    </div>
                    <div className="mb-2">
                      <span className="font-semibold">Invitee Name:</span>{' '}
                      {sessionInfo.invitedName}
                    </div>
                    <div className="mb-2 flex">
                      <span className="font-semibold mr-1">Description:</span>
                      <span className="whitespace-pre-line flex-1 break-all">
                        {sessionInfo.description}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="mb-6 text-center text-gray-500">
                    Loading session info...
                  </div>
                )}
                <FileUpload
                  onFileSelect={setFile}
                  selectedFile={file}
                  accept=".csv"
                  maxSize={10 * 1024 * 1024}
                />
                <button
                  type="button"
                  disabled={!file}
                  onClick={handleSubmit}
                  className={`mt-6 w-full py-2 rounded-lg font-semibold transition
                  ${file ? 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
                >
                  Submit CSV
                </button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickSessionUpload;
