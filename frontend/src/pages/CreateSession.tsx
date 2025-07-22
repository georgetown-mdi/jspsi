import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield,
  Upload,
  Copy,
  CheckCircle,
  ArrowLeft,
  Users,
  Clock
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import FileUpload from '@/components/FileUpload';
import LoadingSpinner from '@/components/LoadingSpinner';

const CreateSession = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [sessionName, setSessionName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shareableLink, setShareableLink] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [step, setStep] = useState<'setup' | 'waiting'>('setup');

  

  const generateSessionId = () => {
    return (
      Math.random().toString(36).substring(2, 15)
      + Math.random().toString(36).substring(2, 15)
    );
  };

  const handleGenerateLink = async () => {
    if (!sessionName.trim()) {
      toast({
        title: 'Session name required',
        description: 'Please enter a name for your session.',
        variant: 'destructive'
      });
      return;
    }

    if (!file) {
      toast({
        title: 'File required',
        description: 'Please upload your CSV file.',
        variant: 'destructive'
      });
      return;
    }

    setIsGenerating(true);

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const newSessionId = generateSessionId();
    const link = `${window.location.origin}/join/${newSessionId}`;

    setSessionId(newSessionId);
    setShareableLink(link);
    setStep('waiting');
    setIsGenerating(false);

    toast({
      title: 'Session created successfully!',
      description: 'Share the link with the other party to begin.'
    });
  };

  const copyLink = async () => {
    if (shareableLink) {
      await navigator.clipboard.writeText(shareableLink);
      toast({
        title: 'Link copied!',
        description: 'The session link has been copied to your clipboard.'
      });
    }
  };

  const proceedToExecution = () => {
    if (sessionId) {
      navigate(`/execute/${sessionId}`);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
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
            <div className="text-sm text-gray-600">
              Step {step === 'setup' ? '1' : '2'} of 3
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          {step === 'setup' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-gray-900 mb-4">
                  Create New Session
                </h2>
                <p className="text-lg text-gray-600">
                  Set up your session and upload your dataset to get started
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
                  <div>
                    <Label
                      htmlFor="sessionName"
                      className="text-base font-medium"
                    >
                      Session Name
                    </Label>
                    <Input
                      id="sessionName"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="e.g., Customer Overlap Analysis"
                      className="mt-2"
                    />
                    <p className="text-sm text-gray-500 mt-1">
                      Choose a descriptive name that the other party will
                      recognize
                    </p>
                  </div>

                  <div>
                    <Label className="text-base font-medium mb-3 block">
                      Upload Your Dataset
                    </Label>
                    <FileUpload
                      onFileSelect={setFile}
                      selectedFile={file}
                      accept=".csv"
                      maxSize={10 * 1024 * 1024} // 10MB
                    />
                    <p className="text-sm text-gray-500 mt-2">
                      CSV files only • Maximum 10MB • Your data stays in your
                      browser
                    </p>
                  </div>

                  <Button
                    onClick={handleGenerateLink}
                    disabled={isGenerating}
                    className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                  >
                    {isGenerating ? (
                      <>
                        <LoadingSpinner className="mr-2" />
                        Generating Session...
                      </>
                    ) : (
                      <>
                        Generate Shareable Link
                        <Upload className="ml-2 w-5 h-5" />
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {step === 'waiting' && (
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
                          {sessionName}
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
                        <p className="text-sm text-gray-700">{file?.name}</p>
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
                        value={shareableLink || ''}
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
                          Once they join and upload their file, you'll be able
                          to proceed with the intersection.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="flex space-x-4">
                  <Button
                    variant="outline"
                    onClick={() => setStep('setup')}
                    className="flex-1"
                  >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to Setup
                  </Button>
                  <Button
                    onClick={proceedToExecution}
                    className="flex-1 bg-blue-600 hover:bg-blue-700"
                  >
                    Continue to Execution
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateSession;
