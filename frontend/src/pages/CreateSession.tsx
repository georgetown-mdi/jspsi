import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield,
  Upload,
  Users,
  ArrowLeft,
  Info,
  Settings,
  Download
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
  const [initiatedName, setInitiatedName] = useState('');
  const [invitedName, setInvitedName] = useState('');
  const [description, setDescription] = useState('');
  const [enableAdvancedPSI, setEnableAdvancedPSI] = useState(false);
  const [oneTimeLink, setOneTimeLink] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !sessionName.trim()
      || !initiatedName.trim()
      || !invitedName.trim()
      || !file
    ) {
      toast({
        title: 'Missing required fields',
        description: 'Please fill out all required fields and upload your CSV.',
        variant: 'destructive'
      });
      return;
    }
    setIsGenerating(true);
    try {
      // Process the CSV file first
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        const lines = content.split('\n');

        // Remove header if it's a CSV
        let data = lines;
        if (file.type === 'text/csv') {
          data = lines.slice(1);
        }

        // Filter out empty lines
        data = data.filter((line) => line.trim() !== '');

        console.log('Processed advanced session data:', data);

        // Create the session
        const res = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionName,
            initiatedName,
            invitedName,
            description,
            enableAdvancedPSI,
            oneTimeLink
          })
        });
        const sessionData = await res.json();
        if (!sessionData.sessionId) throw new Error('Session creation failed');

        // Store the processed data in sessionStorage
        sessionStorage.setItem(
          `psi_data_${sessionData.sessionId}`,
          JSON.stringify({
            data: data,
            fileName: file.name,
            fileSize: file.size
          })
        );

        navigate(`/session/${sessionData.sessionId}/ready`);
      };

      reader.readAsText(file);
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to create session.',
        variant: 'destructive'
      });
    } finally {
      setIsGenerating(false);
    }
  };

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
            <div className="text-sm text-gray-600">Step 1 of 2</div>
          </div>
        </div>
      </header>
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Create New Session
              </h2>
              <p className="text-lg text-gray-600">
                Set up your session and upload your dataset to get started
              </p>
            </div>
            <form onSubmit={handleCreate}>
              <Card className="shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Users className="w-5 h-5 mr-2 text-blue-600" />
                    Session Setup
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label
                      htmlFor="sessionName"
                      className="text-base font-medium"
                    >
                      Session Name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="sessionName"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="e.g., Customer Overlap Analysis"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="initiatedName"
                      className="text-base font-medium"
                    >
                      Your Name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="initiatedName"
                      value={initiatedName}
                      onChange={(e) => setInitiatedName(e.target.value)}
                      placeholder="e.g., John Doe"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="invitedName"
                      className="text-base font-medium"
                    >
                      Invitee's Name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="invitedName"
                      value={invitedName}
                      onChange={(e) => setInvitedName(e.target.value)}
                      placeholder="e.g., Jane Doe"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="description"
                      className="text-base font-medium"
                    >
                      Description
                    </Label>
                    <textarea
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Add a description for this session (optional)"
                      rows={2}
                      className="mt-1 w-full border border-gray-300 focus:border-gray-400 focus:ring-2 focus:ring-gray-200 px-4 py-2 rounded-lg bg-white text-gray-900 placeholder-gray-400 transition resize-y min-h-[2.5rem] max-h-40 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-2 mt-4">
                    <Label className="text-base font-medium">
                      Advanced Settings
                    </Label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enableAdvancedPSI}
                        onChange={(e) => setEnableAdvancedPSI(e.target.checked)}
                        className="accent-blue-600 h-4 w-4"
                      />
                      <span className="text-sm text-gray-800">
                        Enable Advanced PSI Protocol
                      </span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={oneTimeLink}
                        onChange={(e) => setOneTimeLink(e.target.checked)}
                        className="accent-blue-600 h-4 w-4"
                      />
                      <span className="text-sm text-gray-800">
                        Generate One-Time Link
                      </span>
                    </label>
                  </div>
                  <div>
                    <Label className="text-base font-medium mb-3 block">
                      Upload Your Dataset{' '}
                      <span className="text-red-500">*</span>
                    </Label>
                    <FileUpload
                      onFileSelect={setFile}
                      selectedFile={file}
                      accept=".csv"
                      maxSize={10 * 1024 * 1024}
                    />
                    <p className="text-sm text-gray-500 mt-2">
                      CSV files only • Maximum 10MB • Your data stays in your
                      browser
                    </p>
                    <Card className="mt-6 bg-gray-50 border border-gray-200">
                      <CardContent className="py-4 flex flex-col gap-2 items-center">
                        <button
                          disabled
                          className="w-full flex items-center justify-center gap-2 py-2 rounded border border-gray-300 bg-white text-gray-500 cursor-not-allowed font-semibold shadow-sm hover:shadow transition"
                        >
                          <Settings className="w-4 h-4" />
                          Identify Metadata (Coming Soon)
                        </button>
                        <button
                          disabled
                          className="w-full flex items-center justify-center gap-2 py-2 rounded border border-gray-300 bg-white text-gray-500 cursor-not-allowed font-semibold shadow-sm hover:shadow transition"
                        >
                          <Info className="w-4 h-4" />
                          Clean & Harmonize Data (Coming Soon)
                        </button>
                        <button
                          disabled
                          className="w-full flex items-center justify-center gap-2 py-2 rounded border border-gray-300 bg-white text-gray-500 cursor-not-allowed font-semibold shadow-sm hover:shadow transition"
                        >
                          <Download className="w-4 h-4" />
                          Download Metadata (Coming Soon)
                        </button>
                        <div className="mt-1 text-xs text-gray-400 text-center">
                          In the future, you’ll be able to label columns, clean
                          your data, and save your mapping for reuse!
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  <Button
                    type="submit"
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
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateSession;
