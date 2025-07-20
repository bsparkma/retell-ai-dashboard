import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
  Switch,
  FormControlLabel,
  Chip,
  IconButton,
  Tooltip,
  Alert,
  Drawer,
  CardActions,
  Avatar,
  Badge,
  InputAdornment,
  Divider,
  Stack,
  LinearProgress,
  useTheme,
  useMediaQuery,
  Paper,
  Collapse,
  Fab,
  Snackbar,
  Container,
} from '@mui/material';
import {
  Edit as EditIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Phone as PhoneIcon,
  Settings as SettingsIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  Sort as SortIcon,
  PlayArrow as TestIcon,
  Close as CloseIcon,
  Speed as SpeedIcon,
  Psychology as PsychologyIcon,
  Language as LanguageIcon,
  VolumeUp as VoiceIcon,
  Analytics as StatsIcon,
  Schedule as DurationIcon,
  SentimentSatisfied as SentimentIcon,
  Call as CallIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
  Person as PersonIcon,
  CheckCircle as ActiveIcon,
  RadioButtonUnchecked as InactiveIcon,
} from '@mui/icons-material';
import { agentsApi } from '../services/api';

const Agents = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  
  // State management
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [filterVoice, setFilterVoice] = useState('');
  const [filterLanguage, setFilterLanguage] = useState('');
  const [filterResponsiveness, setFilterResponsiveness] = useState('');
  const [testingAgent, setTestingAgent] = useState(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  // Mock usage statistics for agents
  const [agentStats, setAgentStats] = useState({});

  useEffect(() => {
    fetchAgents();
    generateMockStats();
  }, []);

  const fetchAgents = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await agentsApi.getAgents();
      
      // Handle both direct array and object with agents property
      const agentsData = response.agents || response || [];
      setAgents(agentsData);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
      setError('Failed to load agents. Using demo data.');
      // Use enhanced mock data with more variety
      setAgents(generateEnhancedMockAgents());
    } finally {
      setLoading(false);
    }
  };

  const generateMockStats = () => {
    const stats = {};
    ['1', '2', '3', '4'].forEach(id => {
      stats[id] = {
        callsHandled: Math.floor(Math.random() * 500) + 50,
        avgDuration: Math.floor(Math.random() * 300) + 120, // 2-8 minutes
        sentimentScore: (Math.random() * 2 - 1).toFixed(2), // -1 to 1
        successRate: Math.floor(Math.random() * 30) + 70, // 70-100%
        lastUsed: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toLocaleDateString(),
      };
    });
    setAgentStats(stats);
  };

  const generateEnhancedMockAgents = () => [
    {
      agent_id: '1',
      agent_name: 'Medical Receptionist',
      voice_id: 'sarah',
      voice_temperature: 0.7,
      voice_speed: 1.0,
      responsiveness: 0.85,
      interruption_sensitivity: 0.5,
      enable_backchannel: true,
      backchannel_frequency: 0.3,
      language: 'en-US',
      prompt: 'You are a helpful medical receptionist AI assistant. Your primary responsibilities include scheduling appointments, answering basic medical questions, verifying insurance information, and directing patients to appropriate healthcare resources. Always maintain a professional, empathetic, and patient-friendly demeanor.',
      status: 'active',
    },
    {
      agent_id: '2',
      agent_name: 'Emergency Triage',
      voice_id: 'michael',
      voice_temperature: 0.5,
      voice_speed: 1.1,
      responsiveness: 0.95,
      interruption_sensitivity: 0.7,
      enable_backchannel: false,
      backchannel_frequency: 0.1,
      language: 'en-US',
      prompt: 'You are an emergency medical triage AI specialist. Quickly assess the urgency of medical situations, provide appropriate guidance for emergency care, and prioritize cases based on severity. Always remain calm and provide clear, actionable instructions for emergency situations.',
      status: 'active',
    },
    {
      agent_id: '3',
      agent_name: 'Billing Support',
      voice_id: 'emily',
      voice_temperature: 0.6,
      voice_speed: 0.9,
      responsiveness: 0.6,
      interruption_sensitivity: 0.4,
      enable_backchannel: true,
      backchannel_frequency: 0.4,
      language: 'en-US',
      prompt: 'You are a medical billing support AI agent. Help patients understand their bills, explain insurance coverage, set up payment plans, and resolve billing inquiries. Be patient and thorough when explaining complex billing information.',
      status: 'active',
    },
    {
      agent_id: '4',
      agent_name: 'Pharmacy Assistant',
      voice_id: 'david',
      voice_temperature: 0.8,
      voice_speed: 1.0,
      responsiveness: 0.3,
      interruption_sensitivity: 0.6,
      enable_backchannel: true,
      backchannel_frequency: 0.2,
      language: 'en-US',
      prompt: 'You are a pharmacy assistant AI focused on medication management, prescription refills, drug interactions, and medication counseling. Provide accurate information about medications while emphasizing the importance of consulting with healthcare providers.',
      status: 'inactive',
    },
  ];

  // Extract keyword tags from prompt
  const extractKeywords = (prompt) => {
    const commonWords = ['you', 'are', 'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'your', 'always', 'provide', 'help', 'assist'];
    const words = prompt.toLowerCase().split(/\s+/)
      .filter(word => word.length > 3 && !commonWords.includes(word))
      .map(word => word.replace(/[^\w]/g, ''));
    
    // Get unique words and return top 4
    const uniqueWords = [...new Set(words)];
    return uniqueWords.slice(0, 4);
  };

  // Get responsiveness color and label
  const getResponsivenessInfo = (responsiveness) => {
    if (!responsiveness && responsiveness !== 0) {
      return { color: 'default', label: 'N/A', percentage: 'N/A' };
    }
    
    const percentage = Math.round(responsiveness * 100);
    
    if (percentage >= 70) {
      return { color: 'success', label: 'High', percentage: `${percentage}%` };
    } else if (percentage >= 40) {
      return { color: 'warning', label: 'Medium', percentage: `${percentage}%` };
    } else {
      return { color: 'error', label: 'Low', percentage: `${percentage}%` };
    }
  };

  // Get voice speed info
  const getVoiceSpeedInfo = (speed) => {
    if (!speed) speed = 1.0;
    if (speed > 1.1) return { label: 'Fast', color: 'info' };
    if (speed < 0.9) return { label: 'Slow', color: 'warning' };
    return { label: 'Normal', color: 'success' };
  };

  // Filtered and sorted agents
  const filteredAgents = useMemo(() => {
    let filtered = agents.filter(agent => {
      const matchesSearch = !searchQuery || 
        agent.agent_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.prompt?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesVoice = !filterVoice || agent.voice_id === filterVoice;
      const matchesLanguage = !filterLanguage || agent.language === filterLanguage;
      
      let matchesResponsiveness = true;
      if (filterResponsiveness) {
        const respInfo = getResponsivenessInfo(agent.responsiveness);
        matchesResponsiveness = respInfo.label.toLowerCase() === filterResponsiveness.toLowerCase();
      }

      return matchesSearch && matchesVoice && matchesLanguage && matchesResponsiveness;
    });

    // Sort agents
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.agent_name.localeCompare(b.agent_name);
        case 'responsiveness':
          return (b.responsiveness || 0) - (a.responsiveness || 0);
        case 'speed':
          return (b.voice_speed || 1) - (a.voice_speed || 1);
        case 'status':
          return a.status.localeCompare(b.status);
        default:
          return 0;
      }
    });

    return filtered;
  }, [agents, searchQuery, sortBy, filterVoice, filterLanguage, filterResponsiveness]);

  const handleEditAgent = (agent) => {
    setEditingAgent({ ...agent });
    setEditDrawerOpen(true);
  };

  const handleSaveAgent = async () => {
    try {
      setLoading(true);
      await agentsApi.updateAgent(editingAgent.agent_id, editingAgent);
      
      // Update local state
      setAgents(prev => prev.map(agent => 
        agent.agent_id === editingAgent.agent_id ? editingAgent : agent
      ));
      
      setSuccess('Agent updated successfully');
      setEditDrawerOpen(false);
      setEditingAgent(null);
    } catch (error) {
      setError('Failed to update agent');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingAgent(null);
    setEditDrawerOpen(false);
  };

  const handleInputChange = (field, value) => {
    setEditingAgent(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleTestAgent = (agent) => {
    setTestingAgent(agent.agent_id);
    
    // Simulate test
    setTimeout(() => {
      setTestingAgent(null);
      setSuccess(`Agent "${agent.agent_name}" test completed successfully`);
    }, 2000);
  };

  const clearFilters = () => {
    setSearchQuery('');
    setFilterVoice('');
    setFilterLanguage('');
    setFilterResponsiveness('');
  };

  const formatDuration = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const AgentCard = ({ agent }) => {
    const stats = agentStats[agent.agent_id] || {};
    const responsivenessInfo = getResponsivenessInfo(agent.responsiveness);
    const voiceSpeedInfo = getVoiceSpeedInfo(agent.voice_speed);
    const keywords = extractKeywords(agent.prompt || '');

    return (
      <Card 
        sx={{ 
          height: '100%',
          transition: 'all 0.2s ease-in-out',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: theme.palette.mode === 'dark' 
              ? '0 8px 25px rgba(0,0,0,0.4)' 
              : '0 8px 25px rgba(0,0,0,0.15)',
          }
        }}
      >
        <CardContent sx={{ pb: 1 }}>
          {/* Header */}
          <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
            <Box display="flex" alignItems="center" flex={1}>
              <Avatar
                sx={{
                  bgcolor: agent.status === 'active' ? 'success.main' : 'grey.500',
                  mr: 2,
                  width: 48,
                  height: 48
                }}
              >
                {agent.agent_name?.charAt(0) || 'A'}
              </Avatar>
              <Box flex={1}>
                <Typography variant="h6" fontWeight="bold" noWrap>
                  {agent.agent_name}
                </Typography>
                <Box display="flex" alignItems="center" gap={1} mt={0.5}>
                  <Chip
                    icon={agent.status === 'active' ? <ActiveIcon /> : <InactiveIcon />}
                    label={agent.status || 'Unknown'}
                    color={agent.status === 'active' ? 'success' : 'default'}
                    size="small"
                  />
                  <Chip
                    label={`Voice: ${agent.voice_id || 'N/A'}`}
                    size="small"
                    variant="outlined"
                  />
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Keywords */}
          {keywords.length > 0 && (
            <Box mb={2}>
              <Typography variant="caption" color="textSecondary" gutterBottom>
                Specialties:
              </Typography>
              <Box display="flex" flexWrap="wrap" gap={0.5} mt={0.5}>
                {keywords.map((keyword, index) => (
                  <Chip
                    key={index}
                    label={keyword}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: '0.7rem', height: 20 }}
                  />
                ))}
              </Box>
            </Box>
          )}

          {/* Performance Metrics */}
          <Box mb={2}>
            <Typography variant="caption" color="textSecondary" gutterBottom>
              Performance:
            </Typography>
            <Grid container spacing={1} mt={0.5}>
              <Grid item xs={6}>
                <Paper variant="outlined" sx={{ p: 1, textAlign: 'center' }}>
                  <Typography variant="h6" fontWeight="bold">
                    {stats.callsHandled || '0'}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Calls Handled
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={6}>
                <Paper variant="outlined" sx={{ p: 1, textAlign: 'center' }}>
                  <Typography variant="h6" fontWeight="bold">
                    {stats.successRate || '0'}%
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Success Rate
                  </Typography>
                </Paper>
              </Grid>
            </Grid>
          </Box>

          {/* Configuration Details */}
          <Box mb={2}>
            <Typography variant="caption" color="textSecondary" gutterBottom>
              Configuration:
            </Typography>
            <Stack spacing={1} mt={0.5}>
              <Box display="flex" justifyContent="space-between" alignItems="center">
                <Typography variant="body2">Responsiveness:</Typography>
                <Chip
                  label={responsivenessInfo.percentage}
                  color={responsivenessInfo.color}
                  size="small"
                />
              </Box>
              <Box display="flex" justifyContent="space-between" alignItems="center">
                <Typography variant="body2">Voice Speed:</Typography>
                <Chip
                  label={voiceSpeedInfo.label}
                  color={voiceSpeedInfo.color}
                  size="small"
                />
              </Box>
              <Box display="flex" justifyContent="space-between" alignItems="center">
                <Typography variant="body2">Backchannel:</Typography>
                <Chip
                  label={agent.enable_backchannel ? 'Enabled' : 'Disabled'}
                  color={agent.enable_backchannel ? 'success' : 'default'}
                  size="small"
                />
              </Box>
            </Stack>
          </Box>

          {/* Last Activity */}
          {stats.lastUsed && (
            <Box mb={1}>
              <Typography variant="caption" color="textSecondary">
                Last used: {stats.lastUsed}
              </Typography>
            </Box>
          )}
        </CardContent>

        <CardActions sx={{ justifyContent: 'space-between', px: 2, pb: 2 }}>
          <Box display="flex" gap={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => handleEditAgent(agent)}
            >
              Edit
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<TestIcon />}
              onClick={() => handleTestAgent(agent)}
              disabled={testingAgent === agent.agent_id}
            >
              {testingAgent === agent.agent_id ? 'Testing...' : 'Test'}
            </Button>
          </Box>
        </CardActions>
      </Card>
    );
  };

  if (loading && agents.length === 0) {
    return (
      <Box sx={{ width: '100%' }}>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
          <Stack alignItems="center" spacing={2}>
            <LinearProgress sx={{ width: 200 }} />
            <Typography>Loading agents...</Typography>
          </Stack>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" fontWeight="bold">
          AI Voice Agents
        </Typography>
        <Box display="flex" alignItems="center" gap={2}>
          <Typography variant="body2" color="textSecondary">
            {filteredAgents.length} agent{filteredAgents.length !== 1 ? 's' : ''} found
          </Typography>
        </Box>
      </Box>

      {/* Error/Success Messages */}
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Search and Filters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>
            
            <Grid item xs={6} md={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Sort By</InputLabel>
                <Select
                  value={sortBy}
                  label="Sort By"
                  onChange={(e) => setSortBy(e.target.value)}
                >
                  <MenuItem value="name">Name</MenuItem>
                  <MenuItem value="responsiveness">Responsiveness</MenuItem>
                  <MenuItem value="speed">Voice Speed</MenuItem>
                  <MenuItem value="status">Status</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={2}>
              <Button
                variant="outlined"
                onClick={() => setFiltersExpanded(!filtersExpanded)}
                startIcon={<FilterIcon />}
                fullWidth
              >
                Filters
              </Button>
            </Grid>

            <Grid item xs={12} md={2}>
              <Button
                variant="outlined"
                onClick={clearFilters}
                startIcon={<CloseIcon />}
                fullWidth
              >
                Clear
              </Button>
            </Grid>
          </Grid>

          {/* Expanded Filters */}
          <Collapse in={filtersExpanded}>
            <Box mt={2}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={4}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Voice</InputLabel>
                    <Select
                      value={filterVoice}
                      label="Voice"
                      onChange={(e) => setFilterVoice(e.target.value)}
                    >
                      <MenuItem value="">All Voices</MenuItem>
                      <MenuItem value="sarah">Sarah</MenuItem>
                      <MenuItem value="michael">Michael</MenuItem>
                      <MenuItem value="emily">Emily</MenuItem>
                      <MenuItem value="david">David</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Language</InputLabel>
                    <Select
                      value={filterLanguage}
                      label="Language"
                      onChange={(e) => setFilterLanguage(e.target.value)}
                    >
                      <MenuItem value="">All Languages</MenuItem>
                      <MenuItem value="en-US">English (US)</MenuItem>
                      <MenuItem value="en-GB">English (UK)</MenuItem>
                      <MenuItem value="es-ES">Spanish</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Responsiveness</InputLabel>
                    <Select
                      value={filterResponsiveness}
                      label="Responsiveness"
                      onChange={(e) => setFilterResponsiveness(e.target.value)}
                    >
                      <MenuItem value="">All Levels</MenuItem>
                      <MenuItem value="high">High</MenuItem>
                      <MenuItem value="medium">Medium</MenuItem>
                      <MenuItem value="low">Low</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
              </Grid>
            </Box>
          </Collapse>
        </CardContent>
      </Card>

      {/* Agents Grid */}
      <Grid container spacing={3}>
        {filteredAgents.map((agent) => (
          <Grid item xs={12} sm={6} lg={4} key={agent.agent_id}>
            <AgentCard agent={agent} />
          </Grid>
        ))}
      </Grid>

      {filteredAgents.length === 0 && !loading && (
        <Box textAlign="center" py={8}>
          <Typography variant="h6" color="textSecondary" gutterBottom>
            No agents found
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Try adjusting your search or filter criteria
          </Typography>
        </Box>
      )}

      {/* Edit Agent Drawer */}
      <Drawer
        anchor="right"
        open={editDrawerOpen}
        onClose={handleCancelEdit}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: '90%', md: '60%', lg: '40%' },
            maxWidth: '600px',
          },
        }}
      >
        {editingAgent && (
          <Box sx={{ p: 3 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
              <Typography variant="h5" fontWeight="bold">
                Edit Agent: {editingAgent.agent_name}
              </Typography>
              <IconButton onClick={handleCancelEdit}>
                <CloseIcon />
              </IconButton>
            </Box>

            <Stack spacing={3}>
              {/* Basic Information */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Basic Information
                  </Typography>
                  
                  <Stack spacing={2}>
                    <TextField
                      fullWidth
                      label="Agent Name"
                      value={editingAgent.agent_name || ''}
                      onChange={(e) => handleInputChange('agent_name', e.target.value)}
                    />

                    <FormControl fullWidth>
                      <InputLabel>Voice</InputLabel>
                      <Select
                        value={editingAgent.voice_id || ''}
                        label="Voice"
                        onChange={(e) => handleInputChange('voice_id', e.target.value)}
                      >
                        <MenuItem value="sarah">Sarah</MenuItem>
                        <MenuItem value="michael">Michael</MenuItem>
                        <MenuItem value="emily">Emily</MenuItem>
                        <MenuItem value="david">David</MenuItem>
                      </Select>
                    </FormControl>

                    <FormControl fullWidth>
                      <InputLabel>Language</InputLabel>
                      <Select
                        value={editingAgent.language || 'en-US'}
                        label="Language"
                        onChange={(e) => handleInputChange('language', e.target.value)}
                      >
                        <MenuItem value="en-US">English (US)</MenuItem>
                        <MenuItem value="en-GB">English (UK)</MenuItem>
                        <MenuItem value="es-ES">Spanish</MenuItem>
                      </Select>
                    </FormControl>

                    <FormControl fullWidth>
                      <InputLabel>Status</InputLabel>
                      <Select
                        value={editingAgent.status || 'active'}
                        label="Status"
                        onChange={(e) => handleInputChange('status', e.target.value)}
                      >
                        <MenuItem value="active">Active</MenuItem>
                        <MenuItem value="inactive">Inactive</MenuItem>
                      </Select>
                    </FormControl>
                  </Stack>
                </CardContent>
              </Card>

              {/* Voice Configuration */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Voice Configuration
                  </Typography>
                  
                  <Stack spacing={3}>
                    <Box>
                      <Typography variant="body2" gutterBottom>
                        Voice Temperature: {editingAgent.voice_temperature || 0.7}
                      </Typography>
                      <Slider
                        value={editingAgent.voice_temperature || 0.7}
                        onChange={(e, value) => handleInputChange('voice_temperature', value)}
                        min={0.1}
                        max={1.0}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Box>

                    <Box>
                      <Typography variant="body2" gutterBottom>
                        Voice Speed: {editingAgent.voice_speed || 1.0}
                      </Typography>
                      <Slider
                        value={editingAgent.voice_speed || 1.0}
                        onChange={(e, value) => handleInputChange('voice_speed', value)}
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Box>

                    <Box>
                      <Typography variant="body2" gutterBottom>
                        Responsiveness: {editingAgent.responsiveness || 0.5}
                      </Typography>
                      <Slider
                        value={editingAgent.responsiveness || 0.5}
                        onChange={(e, value) => handleInputChange('responsiveness', value)}
                        min={0.1}
                        max={1.0}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Box>

                    <Box>
                      <Typography variant="body2" gutterBottom>
                        Interruption Sensitivity: {editingAgent.interruption_sensitivity || 0.5}
                      </Typography>
                      <Slider
                        value={editingAgent.interruption_sensitivity || 0.5}
                        onChange={(e, value) => handleInputChange('interruption_sensitivity', value)}
                        min={0.1}
                        max={1.0}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Box>

                    <FormControlLabel
                      control={
                        <Switch
                          checked={editingAgent.enable_backchannel || false}
                          onChange={(e) => handleInputChange('enable_backchannel', e.target.checked)}
                        />
                      }
                      label="Enable Backchannel"
                    />

                    {editingAgent.enable_backchannel && (
                      <Box>
                        <Typography variant="body2" gutterBottom>
                          Backchannel Frequency: {editingAgent.backchannel_frequency || 0.3}
                        </Typography>
                        <Slider
                          value={editingAgent.backchannel_frequency || 0.3}
                          onChange={(e, value) => handleInputChange('backchannel_frequency', value)}
                          min={0.1}
                          max={1.0}
                          step={0.1}
                          marks
                          valueLabelDisplay="auto"
                        />
                      </Box>
                    )}
                  </Stack>
                </CardContent>
              </Card>

              {/* Agent Prompt */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Agent Prompt
                  </Typography>
                  
                  <TextField
                    fullWidth
                    multiline
                    rows={6}
                    label="System Prompt"
                    value={editingAgent.prompt || ''}
                    onChange={(e) => handleInputChange('prompt', e.target.value)}
                    placeholder="Enter the system prompt that defines this agent's behavior and personality..."
                  />
                </CardContent>
              </Card>

              {/* Action Buttons */}
              <Box display="flex" gap={2} justifyContent="flex-end">
                <Button
                  variant="outlined"
                  onClick={handleCancelEdit}
                  startIcon={<CancelIcon />}
                >
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={handleSaveAgent}
                  startIcon={<SaveIcon />}
                  disabled={loading}
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </Button>
              </Box>
            </Stack>
          </Box>
        )}
      </Drawer>

      {/* Success/Error Snackbar */}
      <Snackbar
        open={!!success}
        autoHideDuration={4000}
        onClose={() => setSuccess(null)}
        message={success}
      />
    </Box>
  );
};

export default Agents; 